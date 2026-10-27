import { readCappedResponseText } from './common/http.js';

/**
 * Connected objects inside a view.
 *
 * Two keyless upstreams, one route. Both publish device positions themselves;
 * neither is an inventory, so the response says which provider answered and
 * the client labels the points accordingly:
 *
 *   opensensemap  citizen sensor boxes, published data under PDDL 1.0
 *   ttn           LoRaWAN gateways listed by the Packet Broker mapper; owners
 *                 may hide a gateway's location, so absence is not evidence
 *
 * The proxy exists for three reasons: the browser never calls a third party
 * from a foreign origin, a pan across a city must not become a burst of
 * upstream calls (60 s cache per rounded view), and every response is capped.
 */

const SOURCES = Object.freeze({
  opensensemap: {
    label: 'openSenseMap',
    licence: 'PDDL 1.0',
    url: 'https://api.opensensemap.org/boxes',
  },
  ttn: {
    label: 'The Things Network',
    licence: 'published by TTN',
    url: 'https://mapper.packetbroker.net/api/v2/gateways',
  },
});

const CACHE_MS = 60_000;
const STALE_MAX_MS = 10 * 60_000;
const CACHE_MAX = 64;
const MAX_POINTS = 500;
const OPEN_SENSE_MAP_LIMIT = 20;
const MAX_SPAN_DEG = 6;
const MAX_TTN_RADIUS_M = 100_000;
const TIMEOUT_MS = 15_000;
// openSenseMap and the TTN mapper are volunteer services: name the client so
// they can reach its operator instead of blocking an anonymous datacentre IP.
const USER_AGENT = 'GodsEyeView/0.2 (+https://github.com/Neo690/gods-eye-view)';
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;

/**
 * Validate a view from the query string. A world-scale or malformed view is
 * refused rather than forwarded: an upstream asked for the planet answers
 * with megabytes nobody asked to render.
 * @param {URL} url
 * @returns {{west:number,south:number,east:number,north:number}|null}
 */
export function iotViewFromUrl(url) {
  const read = (name) => Number(url.searchParams.get(name));
  const view = {
    west: read('west'),
    south: read('south'),
    east: read('east'),
    north: read('north'),
  };
  if (!Object.values(view).every(Number.isFinite)) return null;
  if (view.west >= view.east || view.south >= view.north) return null;
  if (view.east - view.west > MAX_SPAN_DEG) return null;
  if (view.north - view.south > MAX_SPAN_DEG) return null;
  if (view.south < -90 || view.north > 90) return null;
  if (view.west < -180 || view.east > 180) return null;
  return view;
}

/** The provider a request asks for; an unknown one is refused, not guessed. */
export function iotSourceFromUrl(url) {
  const name = String(url.searchParams.get('source') || 'opensensemap');
  return Object.hasOwn(SOURCES, name) ? name : null;
}

/** One openSenseMap box, or null when it has no published position. */
export function mapOpenSenseBox(box) {
  const coordinates = box?.currentLocation?.coordinates;
  const lon = Number(coordinates?.[0]);
  const lat = Number(coordinates?.[1]);
  if (!box?._id || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const titles = (Array.isArray(box.sensors) ? box.sensors : [])
    .map((sensor) => String(sensor?.title || '').trim())
    .filter(Boolean);
  return {
    id: `osm:${box._id}`,
    lat,
    lon,
    label: String(box.name || box._id),
    meta: {
      exposure: box.exposure || null,
      sensors: titles.slice(0, 6),
    },
  };
}

/** One Packet Broker gateway, or null when its owner hid the location. */
export function mapTtnGateway(gateway) {
  const lat = Number(gateway?.location?.latitude);
  const lon = Number(gateway?.location?.longitude);
  if (!gateway?.id || !Number.isFinite(lat) || !Number.isFinite(lon))
    return null;
  return {
    id: `ttn:${gateway.id}`,
    lat,
    lon,
    label: String(gateway.id),
    meta: {
      online: gateway.online === true,
      placement: gateway.antennaPlacement || null,
      antennas: Number(gateway.antennaCount) || null,
      updatedAt: gateway.updatedAt || null,
    },
  };
}

/** Centre and radius that cover a view, bounded to what the mapper accepts. */
export function viewToRadius(view) {
  const lat = (view.south + view.north) / 2;
  const lon = (view.west + view.east) / 2;
  const latM = (view.north - view.south) * 111_320;
  const lonM =
    (view.east - view.west) *
    111_320 *
    Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const radius = Math.ceil(Math.max(latM, lonM) / 2);
  return {
    lat,
    lon,
    radius: Math.min(MAX_TTN_RADIUS_M, Math.max(1000, radius)),
  };
}

async function fetchJson(url, { fetchImpl, signal }) {
  const upstream = await fetchImpl(url, {
    signal,
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  });
  if (!upstream.ok) {
    const error = new Error(`upstream answered ${upstream.status}`);
    error.status = upstream.status;
    throw error;
  }
  const { text, tooLarge } = await readCappedResponseText(
    upstream,
    MAX_RESPONSE_BYTES,
  );
  // A provider that answers with more than we asked for is a provider whose
  // answer we cannot reason about; the panel shows a failure, not a guess.
  if (tooLarge) throw new Error('upstream response too large');
  return JSON.parse(text);
}

/**
 * One upstream read, mapped to the route's point shape.
 * @param {string} source
 * @param {{west:number,south:number,east:number,north:number}} view
 * @param {{fetchImpl: Function, signal: AbortSignal}} context
 */
async function readUpstream(source, view, { fetchImpl, signal }) {
  if (source === 'ttn') {
    const { lat, lon, radius } = viewToRadius(view);
    const params = new URLSearchParams({
      'distanceWithin[latitude]': String(lat),
      'distanceWithin[longitude]': String(lon),
      'distanceWithin[distance]': String(radius),
      limit: String(MAX_POINTS),
    });
    const rows = await fetchJson(`${SOURCES.ttn.url}?${params}`, {
      fetchImpl,
      signal,
    });
    return {
      points: (Array.isArray(rows) ? rows : [])
        .map(mapTtnGateway)
        .filter(Boolean),
      upstreamCount: Array.isArray(rows) ? rows.length : 0,
    };
  }
  const params = new URLSearchParams({
    bbox: `${view.west},${view.south},${view.east},${view.north}`,
    // openSenseMap refuses anything above 20 per area answer (measured, 422).
    // It is a sparse network; the TTN source is the denser choice.
    limit: String(OPEN_SENSE_MAP_LIMIT),
  });
  const rows = await fetchJson(`${SOURCES.opensensemap.url}?${params}`, {
    fetchImpl,
    signal,
  });
  return {
    points: (Array.isArray(rows) ? rows : [])
      .map(mapOpenSenseBox)
      .filter(Boolean),
    upstreamCount: Array.isArray(rows) ? rows.length : 0,
  };
}

export function iotSensorsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();

  async function acquire(source, view, signal) {
    const key = [
      source,
      view.west.toFixed(2),
      view.south.toFixed(2),
      view.east.toFixed(2),
      view.north.toFixed(2),
    ].join('|');
    const cached = cache.get(key);
    if (cached && now() - cached.savedAt < CACHE_MS)
      return { ...cached, ageMs: now() - cached.savedAt, stale: false };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const read = await readUpstream(source, view, {
        fetchImpl,
        signal: controller.signal,
      });
      const entry = { ...read, savedAt: now() };
      cache.set(key, entry);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return { ...entry, ageMs: 0, stale: false };
    } catch (error) {
      console.warn(
        `[iot-sensors] ${source} failed: ${error?.message || error}`,
      );
      // A recent view is still better than nothing while the provider is down.
      if (cached && now() - cached.savedAt < STALE_MAX_MS)
        return { ...cached, ageMs: now() - cached.savedAt, stale: true };
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 || status === 502 ? { 'Retry-After': '60' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    if ((url.pathname || '/') !== '/')
      return json(404, { error: 'unknown_route' });
    const view = iotViewFromUrl(url);
    if (!view) return json(400, { error: 'invalid_view' });
    const source = iotSourceFromUrl(url);
    if (!source) return json(400, { error: 'unknown_source' });
    const signal = new AbortController().signal;
    acquire(source, view, signal).then(
      ({ points, upstreamCount, ageMs, stale }) =>
        json(200, {
          points,
          ageMs,
          stale,
          truncated: upstreamCount >= MAX_POINTS,
          source,
          attribution: SOURCES[source],
        }),
      // The upstream's own status is the difference between "the provider is
      // down" and "this host is blocked", which is exactly what the operator
      // needs to read instead of a bare 502.
      (error) =>
        json(502, {
          error: 'iot_upstream_unavailable',
          source,
          upstreamStatus: error?.status ?? null,
          reason:
            error?.name === 'AbortError' ? 'timeout' : (error?.message ?? null),
        }),
    );
  }

  return {
    name: 'iot-sensors',
    configureServer({ middlewares }) {
      middlewares.use('/api/iot/sensors', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/iot/sensors', handler);
    },
  };
}
