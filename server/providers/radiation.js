import {
  MAX_STATIONS,
  RADIATION_NETWORKS,
  SAFECAST_MAX_AGE_MS,
  normalizeBfsSnapshot,
  normalizeCanadaSnapshot,
  normalizeRadmonSnapshot,
  normalizeSafecastSnapshot,
  normalizeSpaceReadings,
  normalizeUradmonitorSnapshot,
} from '../../src/layers/radiation/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { clientKey, makeCostRateLimiter } from './common/rate-limit.js';

/**
 * One snapshot of every radiation network this build can read.
 *
 * Three of them answer anonymously; uRADMonitor answers only the units of the
 * account whose keys are in the environment, so it joins the snapshot when
 * `URADMONITOR_USER_ID` and `URADMONITOR_USER_HASH` are set and is skipped
 * otherwise. The keys stay on this side: the browser never sees them.
 *
 * The browser cannot fetch the anonymous ones either: they send no CORS headers
 * for this origin, and the standalone shell has no Node process. So one route
 * aggregates them, normalizes every row to µSv/h and hands the layer a compact
 * array it can draw directly.
 *
 * Shape of the answer:
 *   { fetchedAt, stations: [...], sources: [{ id, ok, count, stale?, error? }],
 *     space: { protonFlux, protonAt, kp, kpAt, band } | null }
 *
 * A network that fails does not blank the layer: its previous snapshot is
 * reused while it is younger than `STALE_MAX_MS`, and the reason travels in
 * `sources` so the row can say it is degraded rather than pretend.
 */

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 12 * 1024 * 1024;
/** Re-reading seven upstreams on every poll would be rude and slow. */
const CACHE_MS = 5 * 60_000;
/** A failed network keeps serving this long, marked stale. */
const STALE_MAX_MS = 60 * 60_000;
const DEFAULT_PER_MINUTE = 60;

const BFS_URL =
  'https://www.imis.bfs.de/ogc/opendata/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=opendata:odlinfo_odl_1h_latest&outputFormat=application/json';
const CANADA_URL =
  'https://maps-cartes.services.geo.ca/server_serveur/rest/services/HC/fpsn_en/MapServer/1/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson';
const SAFECAST_URL = 'https://api.safecast.org/measurements.json';
const SAFECAST_LIMIT = 1000;
const RADMON_URL = 'https://radmon.org/radmon.php?function=getcombinedlistjson';
const URADMONITOR_URL = 'https://data.uradmonitor.com/api/v1/devices';
const PROTON_URL =
  'https://services.swpc.noaa.gov/json/goes/primary/integral-protons-6-hour.json';
const KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';

const NETWORKS = Object.freeze([
  Object.freeze({
    id: 'bfs',
    url: () => BFS_URL,
    decode: normalizeBfsSnapshot,
  }),
  Object.freeze({
    id: 'canada',
    url: () => CANADA_URL,
    decode: normalizeCanadaSnapshot,
  }),
  Object.freeze({
    id: 'safecast',
    url: (now) =>
      `${SAFECAST_URL}?per_page=${SAFECAST_LIMIT}&since=${encodeURIComponent(
        new Date(now - SAFECAST_MAX_AGE_MS).toISOString(),
      )}`,
    decode: (payload, now) => normalizeSafecastSnapshot(payload, { now }),
  }),
  Object.freeze({
    id: 'radmon',
    url: () => RADMON_URL,
    decode: normalizeRadmonSnapshot,
  }),
  Object.freeze({
    id: 'uradmonitor',
    url: () => URADMONITOR_URL,
    decode: (payload, now) => normalizeUradmonitorSnapshot(payload, { now }),
    /**
     * The only account-gated network here: it answers the units one account
     * owns or was granted, and refuses every other unit. `null` means the keys
     * are absent, so the network is skipped instead of reported as failing.
     */
    headers: ({ uradmonitorId, uradmonitorHash }) =>
      uradmonitorId && uradmonitorHash
        ? {
            'X-User-id': String(uradmonitorId),
            'X-User-hash': String(uradmonitorHash),
          }
        : null,
  }),
]);

/** The catalogue a client can render, without depending on a live fetch. */
export const RADIATION_CATALOG = Object.freeze(
  Object.entries(RADIATION_NETWORKS).map(([id, network]) => ({
    id,
    ...network,
  })),
);

/**
 * Build the radiation route for dev and preview.
 * @param {object} [options]
 * @param {(...args: unknown[]) => Promise<Response>} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {number} [options.cacheMs]
 * @param {number} [options.timeoutMs]
 * @returns {object} A Vite plugin with `/api/radiation` installed.
 */
export function radiationProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cacheMs = CACHE_MS,
  timeoutMs = TIMEOUT_MS,
  perMinute = process.env.GEV_RATELIMIT_RADIATION_PER_MIN,
  uradmonitorId = process.env.URADMONITOR_USER_ID,
  uradmonitorHash = process.env.URADMONITOR_USER_HASH,
} = {}) {
  /** Per-network request headers; `null` marks a network without credentials. */
  const authorization = new Map(
    NETWORKS.map((network) => [
      network.id,
      network.headers
        ? network.headers({ uradmonitorId, uradmonitorHash })
        : {},
    ]),
  );
  const activeNetworks = NETWORKS.filter(
    (network) => authorization.get(network.id) !== null,
  );
  /** @type {Map<string, {rows: Array<object>, fetchedAt: number}>} */
  const snapshots = new Map();
  /** @type {Map<string, {at: number, error: string}>} */
  const failures = new Map();
  let space = null;
  let spaceAt = 0;
  const inFlight = new Map();
  const allow = makeCostRateLimiter(perMinute, DEFAULT_PER_MINUTE);

  async function readJson(url, signal, headers = {}) {
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-radiation/1.0',
        ...headers,
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    return readResponseJsonCapped(response, MAX_BYTES, signal);
  }

  async function loadNetwork(network) {
    const signal = AbortSignal.timeout(timeoutMs);
    const clock = now();
    const payload = await readJson(
      network.url(clock),
      signal,
      authorization.get(network.id),
    );
    const rows = network.decode(payload, clock);
    if (!rows) throw new Error('invalid_snapshot');
    return rows.slice(0, MAX_STATIONS);
  }

  async function loadSpace() {
    const signal = AbortSignal.timeout(timeoutMs);
    const [protons, kp] = await Promise.allSettled([
      readJson(PROTON_URL, signal),
      readJson(KP_URL, signal),
    ]);
    const readings = normalizeSpaceReadings({
      protons: protons.status === 'fulfilled' ? protons.value : undefined,
      kp: kp.status === 'fulfilled' ? kp.value : undefined,
    });
    if (!readings) throw new Error('space_unavailable');
    return readings;
  }

  /** One network's rows, reusing its last good snapshot through an outage. */
  async function acquireNetwork(network) {
    const clock = now();
    const cached = snapshots.get(network.id);
    if (cached && clock - cached.fetchedAt <= cacheMs)
      return { rows: cached.rows, fetchedAt: cached.fetchedAt, stale: false };

    if (!inFlight.has(`net:${network.id}`)) {
      const { promise } = coalesceProxyRequest(
        inFlight,
        `net:${network.id}`,
        async () => {
          const rows = await loadNetwork(network);
          snapshots.set(network.id, { rows, fetchedAt: clock });
          failures.delete(network.id);
          return rows;
        },
      );
      try {
        await promise;
      } catch (error) {
        failures.set(network.id, {
          at: clock,
          error:
            error?.message === 'invalid_snapshot'
              ? 'invalid_snapshot'
              : 'upstream_unavailable',
        });
      }
    } else {
      await inFlight.get(`net:${network.id}`).catch(() => {});
    }

    const fresh = snapshots.get(network.id);
    if (!fresh) return { rows: [], fetchedAt: null, stale: false };
    const stale = clock - fresh.fetchedAt > cacheMs;
    if (stale && clock - fresh.fetchedAt > STALE_MAX_MS)
      return { rows: [], fetchedAt: fresh.fetchedAt, stale: true };
    return { rows: fresh.rows, fetchedAt: fresh.fetchedAt, stale };
  }

  async function acquireSpace() {
    const clock = now();
    if (space && clock - spaceAt <= cacheMs) return space;
    if (!inFlight.has('space')) {
      const { promise } = coalesceProxyRequest(inFlight, 'space', async () => {
        const readings = await loadSpace();
        space = readings;
        spaceAt = now();
        return readings;
      });
      await promise.catch(() => {});
    }
    return space;
  }

  async function snapshot() {
    const results = await Promise.all(
      activeNetworks.map(async (network) => ({
        network,
        ...(await acquireNetwork(network)),
      })),
    );
    const spaceReadings = await acquireSpace().catch(() => null);
    /** @type {Array<object>} */
    const stations = [];
    const sources = [];
    for (const { network, rows, fetchedAt, stale } of results) {
      const failure = failures.get(network.id);
      // Two networks can be interleaved; never exceed one snapshot's budget.
      const room = Math.max(0, MAX_STATIONS - stations.length);
      if (room > 0) stations.push(...rows.slice(0, room));
      sources.push({
        id: network.id,
        // `ok` is "the upstream answered", not "it had rows": an account-scoped
        // network may legitimately answer with no unit at all.
        ok: !failure,
        count: rows.length,
        ...(stale ? { stale: true } : {}),
        ...(fetchedAt ? { fetchedAt } : {}),
        ...(failure ? { error: failure.error } : {}),
      });
    }
    return {
      fetchedAt: now(),
      stations,
      sources,
      space: spaceReadings,
    };
  }

  async function handler(req, res) {
    const json = (status, value, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...headers,
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    if (allow && !allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });

    try {
      const value = await snapshot();
      if (!value.stations.length && !value.space)
        return json(
          503,
          { error: 'radiation_unavailable' },
          { 'Retry-After': '120' },
        );
      const degraded = value.sources.some(
        (source) => !source.ok || source.stale,
      );
      return json(200, value, degraded ? { 'X-Data-Degraded': 'true' } : {});
    } catch (error) {
      console.warn('[radiation] snapshot failed:', error?.message || error);
      return json(
        502,
        { error: 'radiation_unavailable' },
        { 'Retry-After': '60' },
      );
    }
  }

  return {
    name: 'radiation',
    configureServer({ middlewares }) {
      middlewares.use('/api/radiation', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/radiation', handler);
    },
  };
}
