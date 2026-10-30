import { readResponseJsonCapped } from './common/http.js';

/**
 * Vite plugin: N2YO "above" proxy.
 *
 * N2YO answers CORS, so the browser could call it directly — but its key is an
 * account secret with a 1 000-call hourly quota, and a hosted build would bake
 * it into a public bundle. Every other keyed provider in this project is read
 * server-side, so this one is too: `/api/n2yo/above` adds the key, caches an
 * answer for a minute (a layer polls every five), and relays N2YO's own
 * `{"error": ...}` body untouched, because N2YO reports refusals in the body
 * rather than in the status.
 *
 * Unset `N2YO_API_KEY` answers `503 {"error":"no_key"}` so the layer can say
 * "Needs an API key" instead of pretending the sky is empty.
 *
 * Upstream: https://api.n2yo.com/rest/v1/satellite/above/{lat}/{lon}/0/{radius}/0/&apiKey=…
 * @returns {import('vite').Plugin}
 */
export function n2yoProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  apiKey = () => process.env.N2YO_API_KEY,
  cacheMs = 60_000,
  staleMaxMs = 10 * 60_000,
  timeoutMs = 12_000,
} = {}) {
  const MAX_BYTES = 2 * 1024 * 1024;
  /** observer cell -> { payload, at } */
  const cache = new Map();
  const inflight = new Map();

  const key = () => String(apiKey?.() || '').trim();

  /** Clamp exactly as the layer's own URL builder does, then round the cell. */
  function cellFrom(params) {
    const lat = Math.max(-90, Math.min(90, Number(params.get('lat')) || 0));
    const lon = Math.max(-180, Math.min(180, Number(params.get('lon')) || 0));
    const radius = Math.max(
      0,
      Math.min(90, Math.floor(Number(params.get('radius')) || 70)),
    );
    if (![lat, lon, radius].every(Number.isFinite)) return null;
    return `${lat.toFixed(1)}:${lon.toFixed(1)}:${radius}`;
  }

  async function fetchAbove(cell) {
    const [lat, lon, radius] = cell.split(':');
    const url =
      `https://api.n2yo.com/rest/v1/satellite/above/${lat}/${lon}/0/${radius}/0/` +
      `&apiKey=${encodeURIComponent(key())}`;
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-n2yo/1.0',
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    return readResponseJsonCapped(response, MAX_BYTES, undefined);
  }

  const install = (server) => {
    server.middlewares.use('/api/n2yo/above', async (req, res) => {
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
      const cell = cellFrom(params);
      if (!cell) return json(400, { error: 'invalid_observer' });
      if (!key())
        return json(503, { error: 'no_key' }, { 'Retry-After': '600' });

      try {
        const clock = now();
        let entry = cache.get(cell);
        if (entry && clock - entry.at < cacheMs)
          return json(200, entry.payload, { 'x-n2yo-cache': 'HIT' });
        if (!inflight.has(cell)) {
          inflight.set(
            cell,
            fetchAbove(cell)
              .then((payload) => {
                cache.set(cell, { payload, at: clock });
                return payload;
              })
              .finally(() => inflight.delete(cell)),
          );
        }
        let fresh = null;
        try {
          fresh = await inflight.get(cell);
        } catch (error) {
          // An N2YO refusal is its own answer, not an outage.
          const refusal = String(error?.message || '');
          if (/HTTP 4\d\d/.test(refusal)) throw error;
          const stale = cache.get(cell);
          if (stale && clock - stale.at <= staleMaxMs)
            return json(200, stale.payload, { 'x-n2yo-cache': 'STALE-ERROR' });
          throw error;
        }
        if (fresh) return json(200, fresh, { 'x-n2yo-cache': 'MISS' });
        return json(502, { error: 'upstream_unavailable' });
      } catch (error) {
        console.warn('[n2yo] above failed:', error?.message || error);
        return json(
          502,
          { error: 'upstream_unavailable' },
          { 'Retry-After': '60' },
        );
      }
    });
  };

  return {
    name: 'n2yo-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
