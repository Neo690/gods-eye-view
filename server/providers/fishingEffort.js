import { readResponseJsonCapped } from './common/http.js';

/**
 * Vite plugin: Global Fishing Watch apparent-fishing-effort proxy.
 *
 * GFW answers gridded effort through a *report*: a polygon, a date range and a
 * dataset, aggregated over 4Wings cells. Two properties of that API shape this
 * route:
 *
 *  - one token may run **one report at a time** (a second concurrent report
 *    answers 429 with the first one's URL), so reports are queued, never fired
 *    in parallel;
 *  - a report can take tens of seconds (GFW itself answers 524 past 100 s), so
 *    the answer is cached six hours per rounded viewport and day, served stale
 *    for a day through an outage, and identical in-flight views share one call.
 *
 * The browser never sees `GFW_API_TOKEN`; a deployment without it answers
 * `503 {"error":"no_key"}` so the layer can say the key is missing.
 *
 * Route: GET /api/fishing-effort?west=&south=&east=&north=&days=
 * Upstream: POST https://gateway.api.globalfishingwatch.org/v3/4wings/report
 * @returns {import('vite').Plugin}
 */
export function fishingEffortProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  token = () => process.env.GFW_API_TOKEN,
  cacheMs = 6 * 60 * 60_000,
  staleMaxMs = 24 * 60 * 60_000,
  timeoutMs = 50_000,
  maxCells = 800,
  maxSpans = { lon: 90, lat: 60 },
} = {}) {
  const BASE = 'https://gateway.api.globalfishingwatch.org/v3/4wings/report';
  const MAX_BYTES = 24 * 1024 * 1024;
  const cache = new Map();
  /** Serialised reports: one token, one report at a time. */
  let queue = Promise.resolve();
  const isMissingToken = () => !String(token() || '').trim();

  const num = (value, fallback = null) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  /** Clamped viewport, or a reason it cannot be asked for. */
  function viewport(params) {
    const west = num(params.get('west'));
    const south = num(params.get('south'));
    const east = num(params.get('east'));
    const north = num(params.get('north'));
    if ([west, south, east, north].some((value) => value === null))
      return { error: 'invalid_viewport' };
    const lonSpan = Math.abs(east - west);
    const latSpan = Math.abs(north - south);
    if (lonSpan > maxSpans.lon || latSpan > maxSpans.lat)
      return { error: 'area_too_large' };
    const days = Math.max(
      1,
      Math.min(30, Math.floor(num(params.get('days'), 7))),
    );
    return {
      west: Math.max(-180, Math.min(180, west)),
      east: Math.max(-180, Math.min(180, east)),
      south: Math.max(-90, Math.min(90, south)),
      north: Math.max(-90, Math.min(90, north)),
      days,
    };
  }

  const cellKey = (view) =>
    `${view.west.toFixed(1)}:${view.east.toFixed(1)}:${view.south.toFixed(1)}:${view.north.toFixed(1)}:${view.days}:${new Date(now()).toISOString().slice(0, 10)}`;

  /**
   * The report's rows, whichever shape it answered in.
   *
   * The gateway groups its answer by dataset: `entries` is one object per
   * dataset, each holding that dataset's rows. Reading `entries` as if it were
   * the rows themselves found no `lat` on the wrapper and drew nothing, so the
   * layers stayed empty while every call succeeded. A flat answer is still
   * accepted, because it is what a single-dataset report used to return.
   */
  function rowsOf(payload) {
    const out = [];
    for (const entry of Array.isArray(payload?.entries) ? payload.entries : []) {
      if (!entry || typeof entry !== 'object') continue;
      if (num(entry.lat) !== null) {
        out.push(entry);
        continue;
      }
      for (const rows of Object.values(entry))
        if (Array.isArray(rows)) out.push(...rows);
    }
    return out;
  }

  /** One report, reduced to the cells a globe can actually draw. */
  function reduce(entries) {
    const totals = new Map();
    let totalHours = 0;
    for (const entry of entries || []) {
      const lat = num(entry?.lat);
      const lon = num(entry?.lon);
      const hours = num(entry?.hours);
      if (lat === null || lon === null || !hours || hours <= 0) continue;
      const key = `${lat.toFixed(2)}:${lon.toFixed(2)}`;
      totals.set(key, (totals.get(key) || 0) + hours);
      totalHours += hours;
    }
    const cells = [...totals]
      .map(([key, hours]) => {
        const [lat, lon] = key.split(':').map(Number);
        return { lat, lon, hours };
      })
      .sort((a, b) => b.hours - a.hours);
    return {
      cells: cells.slice(0, maxCells),
      cellCount: cells.length,
      totalHours,
      truncated: cells.length > maxCells,
    };
  }

  async function runReport(view) {
    const end = new Date(now());
    const start = new Date(end.getTime() - view.days * 24 * 3600_000);
    const dateRange = `${start.toISOString().slice(0, 10)},${end
      .toISOString()
      .slice(0, 10)}`;
    const polygon = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [view.west, view.south],
                [view.east, view.south],
                [view.east, view.north],
                [view.west, view.north],
                [view.west, view.south],
              ],
            ],
          },
        },
      ],
    };
    // `group-by` is not optional: without it the gateway answers 422
    // ("group-by could be VESSEL_ID,FLAG,…") and the route was a permanent
    // 502 even with a valid token. FLAG keeps the rows few enough to draw and
    // `reduce` sums a cell's flags back into one number of hours.
    //
    // `spatial-aggregation` is deliberately absent: `true` merges the whole
    // viewport into one row per group, with no coordinates at all, which is
    // nothing a globe can place.
    const query = new URLSearchParams({
      format: 'JSON',
      'temporal-resolution': 'ENTIRE',
      'spatial-resolution': 'LOW',
      'group-by': 'FLAG',
      'date-range': dateRange,
    });
    query.append('datasets[0]', 'public-global-fishing-effort:latest');
    const response = await fetchImpl(`${BASE}?${query}`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${String(token()).trim()}`,
        'User-Agent': 'gods-eye-view-fishing-effort/1.0',
      },
      // `geojson` is an object, not a stringified one: stringifying it makes
      // the gateway answer 422 "body malformed" before it ever looks at the
      // token.
      body: JSON.stringify({ geojson: polygon }),
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await readResponseJsonCapped(
      response,
      MAX_BYTES,
      undefined,
    );
    return reduce(rowsOf(payload));
  }

  const install = (server) => {
    server.middlewares.use('/api/fishing-effort', async (req, res) => {
      const json = (status, value, headers = {}) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...headers,
        });
        res.end(JSON.stringify(value));
      };
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      const params = new URL(req.url || '/', 'http://localhost').searchParams;
      const view = viewport(params);
      if (view.error)
        return json(400, { error: view.error }, { 'Retry-After': '60' });
      if (isMissingToken())
        return json(503, { error: 'no_key' }, { 'Retry-After': '600' });

      const key = cellKey(view);
      const clock = now();
      const cached = cache.get(key);
      if (cached && clock - cached.at < cacheMs)
        return json(
          200,
          { ...cached.value, stale: false },
          {
            'x-fishing-effort-cache': 'HIT',
          },
        );
      if (cache.size > 60) {
        for (const [entryKey, entry] of cache)
          if (clock - entry.at > staleMaxMs) cache.delete(entryKey);
      }

      try {
        const pending = queue.then(() => runReport(view));
        // Keep the chain alive even when this report throws.
        queue = pending.catch(() => {});
        const value = await pending;
        cache.set(key, { at: clock, value });
        return json(
          200,
          { ...value, fetchedAt: clock, stale: false },
          {
            'x-fishing-effort-cache': 'MISS',
          },
        );
      } catch (error) {
        const stale = cache.get(key);
        console.warn(
          '[fishing-effort] report failed:',
          error?.message || error,
        );
        if (stale && clock - stale.at <= staleMaxMs)
          return json(
            200,
            { ...stale.value, stale: true },
            {
              'x-fishing-effort-cache': 'STALE-ERROR',
            },
          );
        return json(
          502,
          { error: 'fishing_effort_unavailable' },
          { 'Retry-After': '900' },
        );
      }
    });
  };

  return {
    name: 'fishing-effort-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
