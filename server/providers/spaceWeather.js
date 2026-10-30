import {
  geomagneticLevel,
  normalizeAuroraGrid,
  normalizeFlareRecords,
  normalizeKpReading,
  normalizeKpSeries,
} from '../../src/layers/spaceWeather/records.js';
import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { clientKey, makeCostRateLimiter } from './common/rate-limit.js';

/**
 * One snapshot of the space-weather products the solar-storm layer draws.
 *
 * Four SWPC reads answer it: the GOES X-ray flare log, the one-minute and
 * three-hourly planetary K index, and the OVATION aurora grid. The browser
 * could fetch them itself (SWPC sends CORS headers), but the grid is ~900 KB
 * and every client would re-read it, and the APK's asset origin is not the
 * SWPC origin. So one route caches them, trims the grid to the drawn cells and
 * answers the layer's own shape.
 *
 * Shape of the answer:
 *   { fetchedAt, kp: { value, at, observedKp, series: [{ at, kp }] },
 *     flares: [...], aurora: { observedAt, forecastAt, peak, points },
 *     alert: { grade, code, kp },
 *     sources: [{ id, ok, count, error? }] }
 *
 * A product that fails does not blank the layer: the others still answer and
 * the reason travels in `sources`, so the row can say it is degraded rather
 * than pretend a quiet Sun.
 */

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 16 * 1024 * 1024;
/** SWPC refreshes the oval hourly; a three-minute cache is plenty fresh. */
const CACHE_MS = 3 * 60_000;
/** A failed product keeps serving this long, marked stale. */
const STALE_MAX_MS = 60 * 60_000;
const DEFAULT_PER_MINUTE = 60;

const FLARES_URL =
  'https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json';
const KP_1M_URL =
  'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';
const KP_3H_URL =
  'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const AURORA_URL =
  'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';

const PRODUCTS = Object.freeze([
  Object.freeze({ id: 'flares', url: FLARES_URL }),
  Object.freeze({ id: 'kp-1m', url: KP_1M_URL }),
  Object.freeze({ id: 'kp-3h', url: KP_3H_URL }),
  Object.freeze({ id: 'aurora', url: AURORA_URL }),
]);

/**
 * Build the space-weather route for dev and preview.
 * @param {object} [options]
 * @param {(...args: unknown[]) => Promise<Response>} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {number} [options.cacheMs]
 * @param {number} [options.timeoutMs]
 * @returns {object} A Vite plugin with `/api/space-weather` installed.
 */
export function spaceWeatherProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cacheMs = CACHE_MS,
  timeoutMs = TIMEOUT_MS,
  perMinute = process.env.GEV_RATELIMIT_SPACE_WEATHER_PER_MIN,
} = {}) {
  /** @type {Map<string, {payload: any, fetchedAt: number}>} */
  const snapshots = new Map();
  /** @type {Map<string, {at: number, error: string}>} */
  const failures = new Map();
  const inFlight = new Map();
  const allow = makeCostRateLimiter(perMinute, DEFAULT_PER_MINUTE);

  async function readJson(url, signal) {
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gods-eye-view-space-weather/1.0',
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    return readResponseJsonCapped(response, MAX_BYTES, signal);
  }

  /** One product, reusing its last good payload through an outage. */
  async function acquire(product) {
    const clock = now();
    const cached = snapshots.get(product.id);
    if (cached && clock - cached.fetchedAt <= cacheMs)
      return {
        payload: cached.payload,
        fetchedAt: cached.fetchedAt,
        stale: false,
      };
    if (!inFlight.has(product.id)) {
      const { promise } = coalesceProxyRequest(
        inFlight,
        product.id,
        async () => {
          const payload = await readJson(
            product.url,
            AbortSignal.timeout(timeoutMs),
          );
          snapshots.set(product.id, { payload, fetchedAt: clock });
          failures.delete(product.id);
          return payload;
        },
      );
      try {
        await promise;
      } catch (error) {
        failures.set(product.id, {
          at: clock,
          error:
            error?.name === 'TimeoutError'
              ? 'upstream_timeout'
              : 'upstream_unavailable',
        });
      }
    } else {
      await inFlight.get(product.id).catch(() => {});
    }
    const fresh = snapshots.get(product.id);
    if (!fresh) return { payload: null, fetchedAt: null, stale: false };
    const age = clock - fresh.fetchedAt;
    if (age > cacheMs && age > STALE_MAX_MS)
      return { payload: null, fetchedAt: fresh.fetchedAt, stale: true };
    return {
      payload: fresh.payload,
      fetchedAt: fresh.fetchedAt,
      stale: age > cacheMs,
    };
  }

  async function snapshot() {
    const clock = now();
    const results = await Promise.all(
      PRODUCTS.map(async (product) => ({
        product,
        ...(await acquire(product)),
      })),
    );
    const byId = new Map(
      results.map(({ product, payload }) => [product.id, payload]),
    );
    const sources = results.map(({ product, payload, stale, fetchedAt }) => {
      const failure = failures.get(product.id);
      return {
        id: product.id,
        ok: !failure && payload != null,
        count: Array.isArray(payload)
          ? payload.length
          : Array.isArray(payload?.coordinates)
            ? payload.coordinates.length
            : payload
              ? 1
              : 0,
        ...(stale ? { stale: true } : {}),
        ...(fetchedAt ? { fetchedAt } : {}),
        ...(failure && !payload ? { error: failure.error } : {}),
      };
    });

    const kpReading = normalizeKpReading(byId.get('kp-1m'));
    const series = normalizeKpSeries(byId.get('kp-3h'));
    const flares = normalizeFlareRecords(byId.get('flares'), { now: clock });
    const aurora = normalizeAuroraGrid(byId.get('aurora'));

    if (!kpReading && !series.length && !flares.length && !aurora) return null;

    return {
      fetchedAt: clock,
      kp: {
        value: kpReading?.kp ?? series.at(-1)?.kp ?? null,
        at: kpReading?.at ?? series.at(-1)?.at ?? null,
        observedKp: kpReading?.observedKp ?? null,
        series,
      },
      flares,
      aurora,
      alert: geomagneticLevel(kpReading?.kp ?? series.at(-1)?.kp),
      sources,
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
      if (!value)
        return json(
          503,
          { error: 'space_weather_unavailable' },
          { 'Retry-After': '120' },
        );
      const degraded = value.sources.some(
        (source) => !source.ok || source.stale,
      );
      return json(200, value, degraded ? { 'X-Data-Degraded': 'true' } : {});
    } catch (error) {
      console.warn('[space-weather] snapshot failed:', error?.message || error);
      return json(
        502,
        { error: 'space_weather_unavailable' },
        { 'Retry-After': '60' },
      );
    }
  }

  return {
    name: 'space-weather',
    configureServer({ middlewares }) {
      middlewares.use('/api/space-weather', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/space-weather', handler);
    },
  };
}
