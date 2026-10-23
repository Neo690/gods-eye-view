/**
 * The `/api/*` routes the page answers itself inside the Android shell.
 *
 * A standalone APK has no Node process, so a route the shell does not know
 * lands on the asset store. `LiveApi` (Java) serves the keyless feeds whose
 * contract is a plain fetch; this module covers the routes whose logic already
 * lives in the bundle — the page runs the same normaliser the server runs, and
 * only the cross-origin GET it cannot make itself goes through the shell's
 * fixed-host `/api/upstream` read-through.
 *
 * Installing the shim is a no-op outside the shell, so the same build keeps
 * talking to its own origin on the desktop and in the browser.
 */

import {
  GNSS_CLASSIFIER,
  GNSS_WINDOW_MS,
  normalizeGnssAircraft,
} from '../layers/gnss/records.js';

const SHELL_HOST = 'appassets.androidplatform.net';
/** adsb.lol regional snapshot, the same radius the server asks for. */
const GNSS_RADIUS_NM = 250;

/**
 * @param {?Location} [location]
 * @returns {boolean} Whether the page is running from the Android asset store.
 */
export function inAndroidShell(location = globalThis.location) {
  return location?.hostname === SHELL_HOST;
}

/**
 * The whole-degree anchor the server snaps to, so nearby views share a read.
 * @param {string} search - A query string, with or without its leading `?`.
 * @returns {?{lat: number, lon: number}} `null` when the view is not usable.
 */
export function gnssAnchorFromSearch(search) {
  const params = new URLSearchParams(search);
  const rawLat = params.get('lat');
  const rawLon = params.get('lon');
  // `Number(null)` is 0, so a missing parameter must be refused explicitly.
  if (!rawLat || !rawLon) return null;
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: Math.round(lat), lon: Math.round(lon) };
}

/**
 * @param {number} status
 * @param {object} body
 * @returns {Response}
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * `/api/gnss-integrity?lat=&lon=` — the server's answer, built here from the
 * raw adsb.lol snapshot with the layer's own classifier.
 *
 * @param {object} options
 * @param {string} options.search
 * @param {(input: string) => Promise<Response>} [options.upstream]
 *   Fetches the shell's read-through route; injected by tests.
 * @param {() => number} [options.now]
 * @returns {Promise<Response>}
 */
export async function gnssIntegrityResponse({
  search,
  upstream,
  now = () => Date.now(),
} = {}) {
  const anchor = gnssAnchorFromSearch(search);
  if (!anchor) return jsonResponse(400, { error: 'invalid_anchor' });
  const target =
    `https://api.adsb.lol/v2/lat/${anchor.lat}/lon/${anchor.lon}` +
    `/dist/${GNSS_RADIUS_NM}`;
  let payload;
  try {
    const response = await upstream(
      `/api/upstream?url=${encodeURIComponent(target)}`,
    );
    if (!response?.ok) throw new Error('upstream_unavailable');
    payload = await response.json();
  } catch {
    return jsonResponse(502, { error: 'gnss_integrity_unavailable' });
  }
  const rows = normalizeGnssAircraft(payload);
  if (!rows) return jsonResponse(502, { error: 'gnss_integrity_unavailable' });
  const sourceNow = payload.now;
  if (!Number.isFinite(sourceNow) || sourceNow <= 0) {
    return jsonResponse(502, { error: 'gnss_integrity_unavailable' });
  }
  const fetchedAt = Math.min(
    now(),
    sourceNow > 10_000_000_000 ? sourceNow : sourceNow * 1000,
  );
  // The server refuses a snapshot older than the layer's own window; so do we.
  if (now() - fetchedAt > GNSS_WINDOW_MS) {
    return jsonResponse(502, { error: 'gnss_integrity_unavailable' });
  }
  return jsonResponse(200, {
    fetchedAt,
    anchor,
    radiusNm: GNSS_RADIUS_NM,
    classifier: GNSS_CLASSIFIER.id,
    rows,
    ageMs: 0,
  });
}

/** Routes this module answers, keyed by pathname. */
const ROUTES = {
  '/api/gnss-integrity': (search, context) =>
    gnssIntegrityResponse({ search, upstream: context.upstream }),
};

/**
 * Wrap `fetch` so the routes above are answered in the page. Any other request,
 * including everything LiveApi serves, goes through untouched.
 *
 * @param {object} [options]
 * @param {?Location} [options.location]
 * @param {typeof fetch} [options.fetchImpl] - The shell's own fetch.
 * @param {(input: string) => Promise<Response>} [options.upstream]
 * @returns {boolean} Whether the shim was installed.
 */
export function installInAppApi({
  location = globalThis.location,
  fetchImpl = globalThis.fetch,
  upstream,
} = {}) {
  if (!inAndroidShell(location) || typeof fetchImpl !== 'function')
    return false;
  if (fetchImpl.__gevInAppApi) return false;
  const context = {
    upstream: upstream || ((input) => fetchImpl(input, { cache: 'no-store' })),
  };
  const shim = async (input, init) => {
    const raw = typeof input === 'string' ? input : input?.url;
    if (typeof raw === 'string') {
      const url = new URL(raw, location.href);
      const route = url.origin === location.origin && ROUTES[url.pathname];
      if (route) {
        const method = (init?.method || 'GET').toUpperCase();
        if (method !== 'GET') {
          return jsonResponse(405, { error: 'method_not_allowed' });
        }
        return route(url.search, context);
      }
    }
    return fetchImpl(input, init);
  };
  shim.__gevInAppApi = true;
  globalThis.fetch = shim;
  return true;
}
