import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readCappedResponseText } from './common/http.js';

/**
 * Radio sites inside a view.
 *
 * Two sources, deliberately not blended, because they are different objects:
 *
 *   anfr        physical supports (pylons, roofs) published by the French
 *               spectrum agency under Licence Ouverte 2.0, read from an
 *               extract this checkout builds with `npm run towers:build`.
 *   opencellid  a position per logical cell, estimated from community
 *               measurements (CC BY-SA 4.0), fetched live and keyed.
 *
 * Neither is a worldwide inventory. When nothing is configured the route says
 * so with a 503 and a next step, instead of an empty list that would read as
 * "no antennas here".
 */

const MAX_POINTS = 800;
const MAX_SPAN_DEG = 6;
const CACHE_MS = 5 * 60_000;
const STALE_MAX_MS = 30 * 60_000;
const CACHE_MAX = 48;
const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const OPENCELLID_URL = 'https://opencellid.org/cell/getInArea';

/** Where the ANFR extract lives once built; both forms are accepted. */
export const ANFR_STORE_CANDIDATES = Object.freeze([
  'data/anfr/cell-towers.json.gz',
  'data/anfr/cell-towers.json',
]);

export function cellViewFromUrl(url) {
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

export function cellSourceFromUrl(url) {
  const name = String(url.searchParams.get('source') || '');
  if (name === 'anfr' || name === 'opencellid') return name;
  return name ? null : 'auto';
}

/**
 * Keep the sites inside a view, up to the cap. A linear scan over an extract of
 * a few hundred thousand rows is a couple of milliseconds and needs no index.
 * @param {Array<object>} sites
 * @param {{west:number,south:number,east:number,north:number}} view
 * @param {number} [limit]
 */
export function filterSites(sites, view, limit = MAX_POINTS) {
  const out = [];
  let matched = 0;
  for (const site of Array.isArray(sites) ? sites : []) {
    const lat = Number(site?.lat);
    const lon = Number(site?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < view.south || lat > view.north) continue;
    if (lon < view.west || lon > view.east) continue;
    matched += 1;
    if (out.length < limit) out.push(site);
  }
  return { points: out, matched, truncated: matched > out.length };
}

/** One OpenCelliD row became a point, or it did not. */
export function mapOpenCellIdCell(cell) {
  const lat = Number(cell?.lat);
  const lon = Number(cell?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const id = [cell.mcc, cell.mnc, cell.area, cell.cellid]
    .filter((part) => part !== undefined && part !== null)
    .join('-');
  return {
    id: `ocid:${id || `${lat},${lon}`}`,
    lat,
    lon,
    label: cell.radio ? `${cell.radio} ${id}` : id,
    meta: {
      radio: cell.radio || null,
      mcc: cell.mcc ?? null,
      mnc: cell.mnc ?? null,
      samples: Number(cell.samples) || null,
      // OpenCelliD positions are reported estimates, not surveyed masts.
      estimate: true,
    },
  };
}

/**
 * Read the ANFR extract once and keep it in memory.
 * @param {object} [options]
 * @param {string} [options.file]
 */
export async function loadAnfrStore({ file } = {}) {
  if (!file || !existsSync(file)) return null;
  const raw = file.endsWith('.gz')
    ? gunzipSync(await readFile(file)).toString('utf8')
    : await readFile(file, 'utf8');
  const payload = JSON.parse(raw);
  const sites = Array.isArray(payload?.sites) ? payload.sites : [];
  if (!sites.length) return null;
  return { sites, generatedAt: payload.generatedAt ?? null };
}

async function fetchJson(url, signal, fetchImpl) {
  const upstream = await fetchImpl(url, {
    signal,
    headers: { accept: 'application/json' },
  });
  if (!upstream.ok) {
    const error = new Error(`upstream ${upstream.status}`);
    error.status = upstream.status;
    throw error;
  }
  const { text, tooLarge } = await readCappedResponseText(
    upstream,
    MAX_RESPONSE_BYTES,
  );
  if (tooLarge) throw new Error('upstream response too large');
  return JSON.parse(text);
}

export function cellTowersProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
  anfrFile,
  loadStore = loadAnfrStore,
} = {}) {
  const cache = new Map();
  let store;
  let storeLoaded = false;
  // Extraction happens from the repository root, which is also where the
  // build script writes the extract.
  const storeFiles = anfrFile
    ? [anfrFile]
    : ANFR_STORE_CANDIDATES.map((name) => path.resolve(name));

  async function anfr() {
    if (storeLoaded) return store;
    storeLoaded = true;
    for (const file of storeFiles) {
      try {
        // The default loader returns null for a file that is not there; an
        // injected loader still gets its chance to answer.
        store = await loadStore({ file });
      } catch {
        store = null;
      }
      if (store) return store;
    }
    return null;
  }

  const openCellIdKey = () => String(env.OPENCELLID_API_KEY || '').trim();

  /** The source a request ends up using, and why when there is none. */
  async function resolveSource(requested) {
    if (requested === 'anfr')
      return (await anfr())
        ? { source: 'anfr' }
        : { source: null, reason: 'anfr_not_built' };
    if (requested === 'opencellid')
      return openCellIdKey()
        ? { source: 'opencellid' }
        : { source: null, reason: 'opencellid_key_missing' };
    if (await anfr()) return { source: 'anfr' };
    if (openCellIdKey()) return { source: 'opencellid' };
    return { source: null, reason: 'nothing_configured' };
  }

  async function readAnfr(view) {
    const { sites } = await anfr();
    const { points, matched, truncated } = filterSites(sites, view);
    return { points, upstreamCount: matched, truncated };
  }

  async function readOpenCellId(view, signal) {
    const params = new URLSearchParams({
      key: openCellIdKey(),
      BBOX: `${view.west},${view.south},${view.east},${view.north}`,
      format: 'json',
      // The documented maximum for one area page.
      limit: '50',
    });
    const payload = await fetchJson(
      `${OPENCELLID_URL}?${params}`,
      signal,
      fetchImpl,
    );
    const rows = Array.isArray(payload?.cells)
      ? payload.cells
      : Array.isArray(payload)
        ? payload
        : [];
    return {
      points: rows.map(mapOpenCellIdCell).filter(Boolean),
      upstreamCount: Number(payload?.count) || rows.length,
      truncated: Number(payload?.count) > rows.length,
    };
  }

  async function acquire(source, view, signal) {
    if (source === 'anfr')
      return { ...(await readAnfr(view)), ageMs: 0, stale: false };
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
      const read = await readOpenCellId(view, controller.signal);
      const entry = { ...read, savedAt: now() };
      cache.set(key, entry);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return { ...entry, ageMs: 0, stale: false };
    } catch (error) {
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
    const view = cellViewFromUrl(url);
    if (!view) return json(400, { error: 'invalid_view' });
    const requested = cellSourceFromUrl(url);
    if (!requested) return json(400, { error: 'unknown_source' });
    resolveSource(requested === 'auto' ? null : requested).then(
      async (resolved) => {
        if (!resolved.source)
          return json(503, {
            error: 'cell_towers_not_configured',
            reason: resolved.reason,
            hint: 'Run `npm run towers:build` for the ANFR extract, or set OPENCELLID_API_KEY.',
          });
        try {
          const read = await acquire(
            resolved.source,
            view,
            new AbortController().signal,
          );
          json(200, {
            points: read.points,
            ageMs: read.ageMs ?? 0,
            stale: read.stale === true,
            truncated: read.truncated === true,
            source: resolved.source,
            matched: read.upstreamCount,
            attribution:
              resolved.source === 'anfr'
                ? { label: 'ANFR', licence: 'Licence Ouverte 2.0' }
                : { label: 'OpenCelliD', licence: 'CC BY-SA 4.0' },
          });
        } catch {
          json(502, {
            error: 'cell_towers_unavailable',
            source: resolved.source,
          });
        }
      },
      () => json(502, { error: 'cell_towers_unavailable' }),
    );
  }

  return {
    name: 'cell-towers',
    configureServer({ middlewares }) {
      middlewares.use('/api/cell-towers', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/cell-towers', handler);
    },
  };
}
