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
import { normalizeFirePerimeterSnapshot } from '../layers/perimeters/records.js';
import {
  normalizeRadioBrowserStation,
  publicRadioStation,
} from '../sources/radioBrowser.js';
import {
  CYCLONE_STATUS_URL,
  attachCycloneGeometry,
  cycloneGeometryUrls,
  describeCycloneSnapshot,
  parseCycloneStatus,
} from './cycloneStorms.js';

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

/**
 * WFIGS current interagency fire perimeters: the same query, offsets and
 * offset cap the server uses, so the page sees the same snapshot.
 */
const WFIGS_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/' +
  'WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?' +
  new URLSearchParams({
    where: '1=1',
    outFields: [
      'poly_IncidentName',
      'attr_UniqueFireIdentifier',
      'attr_IncidentSize',
      'attr_PercentContained',
      'attr_POOState',
      'attr_IncidentTypeCategory',
      'attr_FireDiscoveryDateTime',
      'poly_DateCurrent',
      'attr_FireCause',
      'attr_FireBehaviorGeneral',
      'attr_TotalIncidentPersonnel',
      'attr_POOCounty',
      'attr_EstimatedCostToDate',
      'attr_IncidentComplexityLevel',
      'attr_CpxName',
    ].join(','),
    maxAllowableOffset: '0.001',
    outSR: '4326',
    f: 'geojson',
  }).toString();
/** The service caps one response at its maxRecordCount; a peak season pages. */
const WFIGS_MAX_PAGES = 5;

const exceededTransferLimit = (payload) =>
  payload?.exceededTransferLimit === true ||
  payload?.properties?.exceededTransferLimit === true;

/**
 * `/api/fire-perimeters` — WFIGS GeoJSON, normalised by the layer's own
 * records module.
 *
 * @param {object} options
 * @param {(input: string) => Promise<Response>} options.upstream
 * @param {() => number} [options.now]
 * @returns {Promise<Response>}
 */
export async function firePerimetersResponse({
  upstream,
  now = () => Date.now(),
} = {}) {
  const features = [];
  try {
    for (let page = 0; page < WFIGS_MAX_PAGES; page++) {
      const url =
        page === 0 ? WFIGS_URL : `${WFIGS_URL}&resultOffset=${features.length}`;
      const response = await upstream(
        `/api/upstream?url=${encodeURIComponent(url)}`,
      );
      if (!response?.ok) throw new Error('upstream_unavailable');
      const payload = await response.json();
      if (!Array.isArray(payload?.features)) {
        throw new Error('invalid_snapshot');
      }
      features.push(...payload.features);
      if (!exceededTransferLimit(payload) || !payload.features.length) break;
    }
    const rows = normalizeFirePerimeterSnapshot({ features });
    if (!rows) throw new Error('invalid_snapshot');
    return jsonResponse(200, { fetchedAt: now(), rows });
  } catch {
    return jsonResponse(502, { error: 'fire_perimeters_unavailable' });
  }
}

/**
 * `/api/cyclones` — the status document plus the NHC GIS layers, in the shape
 * the layer validates. Geometry that will not parse is not fatal: the storm
 * list still answers, marked `unavailable` for its track and cone, exactly as
 * the server does.
 *
 * @param {object} options
 * @param {(input: string) => Promise<Response>} options.upstream
 * @param {() => number} [options.now]
 * @returns {Promise<Response>}
 */
export async function cyclonesResponse({
  upstream,
  now = () => Date.now(),
} = {}) {
  const read = async (url) => {
    const response = await upstream(
      `/api/upstream?url=${encodeURIComponent(url)}`,
    );
    if (!response?.ok) throw new Error('upstream_unavailable');
    return response.json();
  };
  let storms;
  try {
    storms = parseCycloneStatus(await read(CYCLONE_STATUS_URL), now());
    if (storms.length) {
      try {
        const collections = await Promise.all(cycloneGeometryUrls().map(read));
        storms = attachCycloneGeometry(storms, collections);
      } catch {
        storms = storms.map((storm) => ({
          ...storm,
          geometryStatus: 'unavailable',
        }));
      }
    }
  } catch {
    return jsonResponse(502, { error: 'cyclones_unavailable' });
  }
  return jsonResponse(
    200,
    describeCycloneSnapshot({ storms, fetchedAt: now() }),
  );
}

/**
 * Radio Browser mirrors, in the order the server tries them. The station
 * normalisers are shared with the layer, so only the query lives here.
 */
export const RADIO_MIRRORS = [
  'de1.api.radio-browser.info',
  'de2.api.radio-browser.info',
  'nl1.api.radio-browser.info',
];
const RADIO_LIMIT = 750;

/**
 * `/api/radio/stations` — the click-count chart, in the directory shape the
 * tuner reads.
 *
 * @param {object} options
 * @param {(input: string) => Promise<Response>} options.upstream
 * @param {() => number} [options.now]
 * @returns {Promise<Response>}
 */
export async function radioStationsResponse({
  upstream,
  now = () => Date.now(),
} = {}) {
  const query = new URLSearchParams({
    order: 'clickcount',
    reverse: 'true',
    hidebroken: 'true',
    limit: String(RADIO_LIMIT),
  });
  for (const host of RADIO_MIRRORS) {
    try {
      const url = `https://${host}/json/stations/search?${query}`;
      const response = await upstream(
        `/api/upstream?url=${encodeURIComponent(url)}`,
      );
      if (!response?.ok) continue;
      const rows = await response.json();
      if (!Array.isArray(rows)) continue;
      const stations = rows
        .map((raw) => normalizeRadioBrowserStation(raw))
        .filter(Boolean)
        .map(publicRadioStation);
      if (!stations.length) continue;
      return jsonResponse(200, {
        stations,
        updatedAt: now(),
        stale: false,
        degraded: false,
        degradedReason: null,
        coverage: null,
        acceptedGeneration: null,
        catalogInstance: 'in-app',
      });
    } catch {
      // Try the next mirror; the directory is the same on all of them.
    }
  }
  return jsonResponse(503, {
    error: 'Radio directory is temporarily unavailable',
    degraded: true,
    degradedReason: 'upstream_unavailable',
  });
}

/**
 * `/api/radio/click/{id}` — the directory counts a click per stream start.
 * The answer is what the layer checks: a 204.
 *
 * @param {object} options
 * @param {string} options.id
 * @param {(input: string) => Promise<Response>} options.upstream
 * @returns {Promise<Response>}
 */
export async function radioClickResponse({ id, upstream } = {}) {
  for (const host of RADIO_MIRRORS) {
    try {
      const url = `https://${host}/json/url/${encodeURIComponent(id)}`;
      const response = await upstream(
        `/api/upstream?url=${encodeURIComponent(url)}`,
      );
      if (response?.ok) return new Response(null, { status: 204 });
    } catch {
      // Same mirror rotation as the directory.
    }
  }
  return jsonResponse(503, { error: 'radio_click_unavailable' });
}

/** Routes this module answers, keyed by pathname. */
const ROUTES = {
  '/api/gnss-integrity': (search, context) =>
    gnssIntegrityResponse({ search, upstream: context.upstream }),
  '/api/fire-perimeters': (search, context) =>
    firePerimetersResponse({ upstream: context.upstream }),
  '/api/cyclones': (search, context) =>
    cyclonesResponse({ upstream: context.upstream }),
  '/api/radio/stations': (search, context) =>
    radioStationsResponse({ upstream: context.upstream }),
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
      const method = (init?.method || 'GET').toUpperCase();
      if (url.origin === location.origin) {
        const click = url.pathname.match(
          /^\/api\/radio\/click\/([0-9a-f-]+)$/i,
        );
        if (click) {
          if (method !== 'POST') {
            return jsonResponse(405, { error: 'method_not_allowed' });
          }
          return radioClickResponse({
            id: click[1].toLowerCase(),
            upstream: context.upstream,
          });
        }
        const route = ROUTES[url.pathname];
        if (route) {
          if (method !== 'GET') {
            return jsonResponse(405, { error: 'method_not_allowed' });
          }
          return route(url.search, context);
        }
      }
    }
    return fetchImpl(input, init);
  };
  shim.__gevInAppApi = true;
  globalThis.fetch = shim;
  return true;
}
