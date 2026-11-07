/**
 * Camera security advisories for the catalogued fleet.
 *
 * The route answers one question: which cameras this server already lists have
 * a *published* advisory naming their product line? It reads two public
 * services (CISA's CSAF OT feed and NVD's CVE API) and the CCTV catalogue this
 * server already holds, and joins them by brand and model.
 *
 * Three limits are deliberate:
 *
 *  - No device is contacted. The catalogue is metadata; no camera host, stream
 *    URL or frame proxy is read here, and every outbound request must target
 *    one of the two advisory services (see upstream.js).
 *  - Installed firmware is unknown. A match means "this product line has a
 *    published advisory", not "this camera is exploitable"; the payload says so
 *    on every finding and the layer repeats it.
 *  - No brand-level flagging. An advisory for a brand's other products is
 *    context, never a finding for an unrelated camera.
 *
 * `CAMERA_ADVISORIES_ENABLED=0` disables the route (503). The answer is cached
 * for six hours (`CAMERA_ADVISORIES_TTL_MS`), and a failed rebuild serves the
 * previous answer rather than blanking the layer.
 */

import { admitSameSiteKeyless } from './common/same-site.js';
import {
  CAMERA_BRANDS,
  DEFAULT_CACHE_MS,
  MAX_CISA_ADVISORIES,
  MAX_FINDINGS,
  MAX_NVD_BRANDS,
} from './cameraAdvisories/constants.js';
import {
  brandRecord,
  buildFindings,
  cameraHardware,
} from './cameraAdvisories/matching.js';
import {
  loadCisaAdvisories,
  loadNvdAdvisories,
} from './cameraAdvisories/upstream.js';

/** Brand records present in the catalogue, most cameras first. */
export function catalogueBrands(cameras) {
  const counts = new Map();
  for (const camera of Array.isArray(cameras) ? cameras : []) {
    const hardware = cameraHardware(camera);
    if (!hardware) continue;
    counts.set(hardware.brand, (counts.get(hardware.brand) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, count]) => ({ brand: brandRecord(id), cameras: count }))
    .filter((entry) => entry.brand)
    .sort(
      (a, b) => b.cameras - a.cameras || a.brand.id.localeCompare(b.brand.id),
    );
}

/** One advisory list, first record per source+id. */
function dedupeAdvisories(records) {
  const seen = new Set();
  const out = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.id) continue;
    const key = `${record.source}:${record.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

/**
 * Assemble the served answer from a catalogue and both sources' answers.
 * Exported for tests: the route's own work is cache + HTTP.
 *
 * @param {object} input
 * @param {Array<object>} input.cameras
 * @param {Array<object>} input.records
 * @param {{error?:string, fetched?:number}} [input.cisa]
 * @param {{error?:string, notQueried?:string[]}} [input.nvd]
 * @param {number} [input.generatedAt]
 */
export function cameraAdvisoryPayload({
  cameras,
  records,
  cisa = {},
  nvd = {},
  maxNvdBrands = MAX_NVD_BRANDS,
  generatedAt = Date.now(),
}) {
  const advisories = dedupeAdvisories(records);
  const { findings, stats } = buildFindings({
    cameras,
    advisories,
    maxFindings: MAX_FINDINGS,
  });
  const brands = catalogueBrands(cameras);
  const queried = new Set(
    brands.slice(0, maxNvdBrands).map((entry) => entry.brand.id),
  );
  return Object.freeze({
    generatedAt: new Date(generatedAt).toISOString(),
    cameras: {
      total: Array.isArray(cameras) ? cameras.length : 0,
      identified: stats.identified,
      brands: brands.map((entry) => ({
        id: entry.brand.id,
        cameras: entry.cameras,
        queried: queried.has(entry.brand.id),
      })),
    },
    sources: [
      {
        id: 'cisa-csaf',
        ok: !cisa.error,
        advisories: advisories.filter((record) => record.source === 'cisa')
          .length,
        ...(cisa.error ? { error: cisa.error } : {}),
      },
      {
        id: 'nvd',
        ok: !nvd.error,
        advisories: advisories.filter((record) => record.source === 'nvd')
          .length,
        ...(nvd.error ? { error: nvd.error } : {}),
        ...(Array.isArray(nvd.notQueried) && nvd.notQueried.length
          ? { notQueried: nvd.notQueried }
          : {}),
      },
    ],
    counts: {
      flagged: stats.flagged,
      critical: stats.bySeverity.critical ?? 0,
      high: stats.bySeverity.high ?? 0,
      medium: stats.bySeverity.medium ?? 0,
      low: stats.bySeverity.low ?? 0,
      unscored: stats.bySeverity.unscored ?? 0,
      advisories: advisories.length,
      brandOnlyAdvisories: stats.brandOnlyAdvisories,
      truncated: stats.truncated,
    },
    // The catalogue never carries a firmware version, and the advisory sources
    // never name one for a specific deployment. Both facts travel with the
    // answer so a consumer cannot present a product-family match as proof.
    firmwareObserved: false,
    deviceContact: 'none',
    findings,
  });
}

/**
 * Build the six-hour answer: read the catalogue, both sources, join.
 *
 * @param {object} options
 * @param {() => Promise<Array<object>>} options.getCatalog
 * @param {Function} options.fetchImpl
 * @param {Function} options.warn
 * @param {number} options.maxCisa
 * @param {number} options.maxNvdBrands
 * @param {number} options.generatedAt
 */
export async function buildCameraAdvisories({
  getCatalog,
  fetchImpl,
  warn,
  maxCisa,
  maxNvdBrands,
  generatedAt = Date.now(),
}) {
  const cameras = await getCatalog();
  const brands = catalogueBrands(cameras);
  const fleetBrands = new Set(brands.map((entry) => entry.brand.id));
  const nvdBrands = brands.slice(0, maxNvdBrands).map((entry) => entry.brand);
  const [cisa, nvd] = await Promise.all([
    loadCisaAdvisories({
      fleetBrands,
      fetchImpl,
      cap: maxCisa,
      warn,
    }),
    loadNvdAdvisories({
      brands: nvdBrands,
      fetchImpl,
      cap: maxNvdBrands,
      warn,
    }),
  ]);
  return cameraAdvisoryPayload({
    cameras,
    records: [...cisa.records, ...nvd.records],
    cisa,
    nvd,
    maxNvdBrands,
    generatedAt,
  });
}

/** Positive integer env value, or the default. */
export function advisoryCountEnv(value, fallback, min, max) {
  const parsed = Number(String(value ?? '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

/**
 * @param {object} [options]
 * @param {() => Promise<Array<object>>} [options.getCatalog] the CCTV catalogue
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.now]
 * @param {Function} [options.warn]
 * @param {boolean} [options.enabled]
 */
export function cameraAdvisoriesProxy({
  getCatalog,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  warn = (...args) => console.warn(...args),
  enabled = process.env.CAMERA_ADVISORIES_ENABLED !== '0',
  cacheMs = advisoryCountEnv(
    process.env.CAMERA_ADVISORIES_TTL_MS,
    DEFAULT_CACHE_MS,
    5 * 60_000,
    24 * 60 * 60_000,
  ),
  maxCisa = advisoryCountEnv(
    process.env.CAMERA_ADVISORIES_MAX_CISA,
    MAX_CISA_ADVISORIES,
    1,
    20,
  ),
  maxNvdBrands = advisoryCountEnv(
    process.env.CAMERA_ADVISORIES_MAX_BRANDS,
    MAX_NVD_BRANDS,
    1,
    MAX_NVD_BRANDS,
  ),
} = {}) {
  if (typeof getCatalog !== 'function') {
    throw new TypeError('Camera advisories require a catalogue reader');
  }
  let cache = null;
  let inflight = null;

  async function refresh() {
    if (inflight) return inflight;
    inflight = buildCameraAdvisories({
      getCatalog,
      fetchImpl,
      warn,
      maxCisa,
      maxNvdBrands,
      generatedAt: now(),
    })
      .then((payload) => {
        cache = { at: now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function answer() {
    if (cache && now() - cache.at < cacheMs) {
      return { payload: cache.payload, ageMs: now() - cache.at, stale: false };
    }
    try {
      const payload = await refresh();
      return { payload, ageMs: 0, stale: false };
    } catch (error) {
      if (cache) {
        warn(
          '[camera-advisories] rebuild failed; serving the previous answer:',
          error?.message || error,
        );
        return {
          payload: cache.payload,
          ageMs: now() - cache.at,
          stale: true,
        };
      }
      throw error;
    }
  }

  function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    if ((url.pathname || '/') !== '/')
      return json(404, { error: 'unknown_route' });
    if (admitSameSiteKeyless(req, res)) return;
    if (!enabled) return json(503, { error: 'camera_advisories_disabled' });
    answer().then(
      ({ payload, ageMs, stale }) => json(200, { ...payload, ageMs, stale }),
      (error) =>
        json(502, {
          error: 'camera_advisories_unavailable',
          reason: error?.message ?? null,
        }),
    );
  }

  return {
    name: 'camera-advisories',
    handler,
    configureServer({ middlewares }) {
      middlewares.use('/api/camera-advisories', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/camera-advisories', handler);
    },
  };
}

export { CAMERA_BRANDS, MAX_CISA_ADVISORIES, MAX_NVD_BRANDS };
