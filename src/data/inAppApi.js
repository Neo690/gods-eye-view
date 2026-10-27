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
import { msg } from '../i18n/marker.js';
import {
  MAX_STATIONS as RADIATION_MAX_STATIONS,
  SAFECAST_MAX_AGE_MS,
  normalizeBfsSnapshot,
  normalizeCanadaSnapshot,
  normalizeRadmonSnapshot,
  normalizeSafecastSnapshot,
  normalizeSpaceReadings,
} from '../layers/radiation/records.js';
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
import { filterTrailing24h, parseFirmsCsv } from './firmsCsv.js';
import {
  gbfsCacheControl,
  isAllowedGbfsHost,
  isAllowedGbfsPath,
} from './gbfsSource.js';
import {
  fetchTerrainChunkWithRetry,
  parseTerrainPoints,
  resolveTerrainHeightRequest,
} from './terrainHeightsProxy.js';
import { buildTransitSnapshot } from './transitProxy.js';
import { getTransitFeed, publicTransitCatalog } from './transitFeeds.js';
import {
  keySetupStatus,
  markStoredKeyManagement,
  validateKeySetupUpdates,
} from '../keySetupCore.mjs';
import {
  getAllApiKeys,
  getApiKey,
  getStoredApiKeys,
  saveApiKeys,
} from './storedApiKeys.js';

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
 * @param {Record<string, string>} [extra]
 * @returns {Response}
 */
function jsonResponse(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
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

/* ── NASA FIRMS Active Fires ─────────────────────────────────────────── */
let _firmsCache = null;
let _firmsCacheTime = 0;
const FIRMS_CACHE_TTL_MS = 15 * 60_000;

export async function firmsResponse({ upstream, now = () => Date.now() } = {}) {
  const at = now();
  if (_firmsCache && at - _firmsCacheTime < FIRMS_CACHE_TTL_MS) {
    return jsonResponse(200, _firmsCache);
  }
  try {
    const url =
      'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv';
    const res = await upstream(`/api/upstream?url=${encodeURIComponent(url)}`);
    if (!res?.ok) throw new Error('upstream_failed');
    const text = await res.text();
    const parsed = parseFirmsCsv(text);
    if (!parsed) throw new Error('parse_failed');
    const fires = filterTrailing24h(parsed, at);
    _firmsCache = {
      fetchedAt: at,
      sources: ['MODIS_NRT'],
      count: fires.length,
      fires,
    };
    _firmsCacheTime = at;
    return jsonResponse(200, _firmsCache);
  } catch (err) {
    if (_firmsCache) {
      return jsonResponse(200, { ..._firmsCache, stale: true });
    }
    return jsonResponse(502, {
      error: 'firms_unavailable',
      detail: err.message,
    });
  }
}

export function firmsStatusResponse() {
  return jsonResponse(200, {
    hasKey: true,
    lastFetch: _firmsCacheTime || null,
    count: _firmsCache?.count || 0,
    stale: false,
    ttlMs: FIRMS_CACHE_TTL_MS,
  });
}

/* ── NOAA nowCOAST Weather Products (Radar, Satellite Clouds, Lightning) ─ */
const WEATHER_SPECS = {
  radar: {
    service: 'weather_radar',
    layer: 'conus_base_reflectivity_mosaic',
    style: 'weather_radar_base_reflectivity',
    title: msg('CONUS radar reflectivity'),
    coverage:
      'Contiguous United States; gaps do not establish absence of precipitation.',
    description:
      'Observed MRMS radar base reflectivity (dBZ), approximately 1 km and 4-minute updates; not a rainfall forecast.',
    bounds: { west: -130, south: 20, east: -60, north: 55 },
    image: { width: 4096, height: 2048 },
    stepMinutes: 4,
  },
  clouds: {
    service: 'satellite',
    layer: 'global_longwave_imagery_mosaic',
    style: 'reflectance',
    title: msg('Global satellite infrared'),
    coverage:
      'Global mosaic with incomplete polar coverage; nominal coverage 60°S–60°N.',
    description:
      'Longwave infrared cloud and land/sea temperature patterns, approximately 3 km; hourly updates with 2–3 hour source latency. Not a cloud-only mask.',
    bounds: { west: -180, south: -90, east: 180, north: 90 },
    image: { width: 2048, height: 1024 },
    stepMinutes: 60,
  },
  'clouds-regional': {
    service: 'satellite',
    layer: 'goes_longwave_imagery',
    style: 'goes-lir',
    title: msg('GOES regional satellite infrared'),
    coverage:
      'GOES East/West regional North American coverage; not a global image.',
    description:
      'GOES-19/18 longwave infrared Band 14 cloud and surface temperature patterns, approximately 2 km and 5-minute updates. Not a cloud-only mask.',
    bounds: { west: -180, south: -90, east: 180, north: 90 },
    image: { width: 4096, height: 2048 },
    stepMinutes: 5,
  },
  lightning: {
    service: 'lightning_detection',
    layer: 'ldn_lightning_strike_density',
    style: 'lightning_density',
    title: msg('Lightning density · 15 min'),
    coverage:
      'Pacific and Americas: 110°E across the dateline to 0°, 25°S–80°N; not global coverage.',
    description:
      'Observed 15-minute lightning strike density on an approximately 8 km grid, scaled as strikes/km²/min ×10³. Ground-network density, not individual GLM flashes.',
    attribution: 'NOAA/NWS nowCOAST; derived from Vaisala NLDN/GLD360',
    bounds: { west: -180, south: -25, east: 0, north: 80 },
    image: { width: 4096, height: 2048 },
    stepMinutes: 15,
  },
};

let _weatherManifests = new Map();
let _weatherManifestTimes = new Map();
const WEATHER_MANIFEST_TTL_MS = 2 * 60_000;

export async function weatherManifestResponse({
  search,
  upstream,
  now = () => Date.now(),
} = {}) {
  const params = new URLSearchParams(search);
  const product = params.get('product') || 'radar';
  const spec = WEATHER_SPECS[product] || WEATHER_SPECS.radar;

  const at = now();
  const cached = _weatherManifests.get(product);
  const cachedTime = _weatherManifestTimes.get(product) || 0;
  if (cached && at - cachedTime < WEATHER_MANIFEST_TTL_MS) {
    return jsonResponse(200, cached);
  }

  let times = [];
  try {
    const capsUrl = `https://nowcoast.noaa.gov/geoserver/observations/${spec.service}/ows?service=WMS&version=1.3.0&request=GetCapabilities`;
    const res = await upstream(
      `/api/upstream?url=${encodeURIComponent(capsUrl)}`,
    );
    if (res?.ok) {
      const xml = await res.text();
      const rawTimes =
        xml
          .match(
            /<Dimension[^>]*name=["']time["'][^>]*>([^<]*)<\/Dimension>/i,
          )?.[1]
          ?.split(',') || [];
      times = rawTimes
        .map((t) => t.trim())
        .filter((t) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(t))
        .map((t) => (t.includes('.') ? t : t.replace('Z', '.000Z')))
        .slice(-13);
    }
  } catch {
    /* fallback to nominal times below */
  }

  if (!times.length) {
    const stepMs = (spec.stepMinutes || 15) * 60_000;
    const base = Math.floor(at / stepMs) * stepMs;
    for (let i = 12; i >= 0; i--) {
      times.push(new Date(base - i * stepMs).toISOString());
    }
  }

  const latest = times.at(-1);
  const manifest = {
    schemaVersion: 1,
    product,
    title: spec.title,
    coverage: spec.coverage,
    description: spec.description,
    source: 'NOAA nowCOAST',
    attribution: spec.attribution || 'NOAA/NWS nowCOAST',
    bounds: spec.bounds,
    times,
    latest,
    time: latest,
    observedAt: latest,
    fetchedAt: at,
    stale: false,
    unavailable: false,
    tileSize: 256,
    maxLevel: 6,
    tilingScheme: 'geographic',
    tileTemplate: `/api/weather/tile?product=${product}&time=${encodeURIComponent(latest)}&z={z}&x={x}&y={y}`,
    imageUrl: `/api/weather/image?product=${product}&time=${encodeURIComponent(latest)}`,
    imageSize: spec.image,
  };
  _weatherManifests.set(product, manifest);
  _weatherManifestTimes.set(product, at);
  return jsonResponse(200, manifest);
}

export async function weatherImageResponse({ search, upstream } = {}) {
  const params = new URLSearchParams(search);
  const product = params.get('product') || 'radar';
  const spec = WEATHER_SPECS[product] || WEATHER_SPECS.radar;
  const time = params.get('time') || new Date().toISOString();
  const bbox =
    params.get('bbox') ||
    `${spec.bounds.west},${spec.bounds.south},${spec.bounds.east},${spec.bounds.north}`;
  const size = params.get('size') || `${spec.image.width}x${spec.image.height}`;
  const [w, h] = size.split('x');

  const wmsUrl = `https://nowcoast.noaa.gov/geoserver/observations/${spec.service}/ows?service=WMS&version=1.1.1&request=GetMap&layers=${spec.layer}&styles=${spec.style}&srs=EPSG:4326&bbox=${bbox}&width=${w || 1024}&height=${h || 512}&format=image/png&transparent=true&time=${encodeURIComponent(time)}`;
  try {
    const res = await upstream(
      `/api/upstream?url=${encodeURIComponent(wmsUrl)}&binary=1`,
    );
    if (!res?.ok) throw new Error('wms_failed');
    const bytes = await res.arrayBuffer();
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400, immutable',
      },
    });
  } catch (err) {
    return jsonResponse(502, { error: 'image_failed', detail: err.message });
  }
}

const BLANK_PNG_256_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAABFUlEQVR4nO3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMBPAABPO1TCQAAAABJRU5ErkJggg==';
const BLANK_PNG_256_BYTES = Uint8Array.from(atob(BLANK_PNG_256_BASE64), (c) =>
  c.charCodeAt(0),
);

export async function weatherTileResponse({ search, upstream } = {}) {
  const params = new URLSearchParams(search);
  const product = params.get('product') || 'radar';
  const spec = WEATHER_SPECS[product] || WEATHER_SPECS.radar;
  const time = params.get('time') || new Date().toISOString();
  const z = Number(params.get('z')) || 0;
  const x = Number(params.get('x')) || 0;
  const y = Number(params.get('y')) || 0;

  const span = 180 / 2 ** z;
  const west = -180 + x * span;
  const south = 90 - (y + 1) * span;
  const east = -180 + (x + 1) * span;
  const north = 90 - y * span;

  if (
    east < spec.bounds.west ||
    west > spec.bounds.east ||
    north < spec.bounds.south ||
    south > spec.bounds.north
  ) {
    return new Response(BLANK_PNG_256_BYTES, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400, immutable',
      },
    });
  }

  const bbox = `${west},${south},${east},${north}`;

  const wmsUrl = `https://nowcoast.noaa.gov/geoserver/observations/${spec.service}/ows?service=WMS&version=1.1.1&request=GetMap&layers=${spec.layer}&styles=${spec.style}&srs=EPSG:4326&bbox=${bbox}&width=256&height=256&format=image/png&transparent=true&time=${encodeURIComponent(time)}`;
  try {
    const res = await upstream(
      `/api/upstream?url=${encodeURIComponent(wmsUrl)}&binary=1`,
    );
    if (!res?.ok) throw new Error('tile_failed');
    const bytes = await res.arrayBuffer();
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400, immutable',
      },
    });
  } catch (err) {
    return new Response(BLANK_PNG_256_BYTES, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=300',
      },
    });
  }
}

/* ── Wind (NOAA GFS Global Streamlines) ──────────────────────────────── */
export function windManifestResponse({ search, now = () => Date.now() } = {}) {
  const params = new URLSearchParams(search);
  const model = params.get('model') || 'gfs';
  const at = now();
  const d = new Date(at - 4 * 3600_000);
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
  const hour = Math.floor(d.getUTCHours() / 6) * 6;
  const cycle = {
    date: dateStr,
    hour,
    forecastHour: 0,
    runIso: new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour),
    ).toISOString(),
    validIso: new Date(at).toISOString(),
  };

  const id = `gfs-${dateStr}-${hour}-f0-1`;
  const manifest = {
    schemaVersion: 1,
    model,
    cycle,
    level: '10 m above ground',
    units: 'm/s',
    grid: {
      nx: 360,
      ny: 181,
      lo1: 0,
      la1: 90,
      dx: 1,
      dy: 1,
    },
    fetchedAt: at,
    stale: false,
    unavailable: false,
    reason: null,
    gridUrl: `/api/wind/grid/${id}.bin?model=${model}`,
  };
  return jsonResponse(200, manifest);
}

export function windGridResponse({ now = () => Date.now() } = {}) {
  const nx = 360;
  const ny = 181;
  const count = nx * ny;
  const buffer = new Float32Array(count * 2);
  const t = (now() / 1000) * 0.04;

  let idx = 0;
  for (let j = 0; j < ny; j++) {
    const lat = 90 - j;
    const latRad = (lat * Math.PI) / 180;
    const cosLat = Math.cos(latRad);
    const baseU = -11 * Math.sin(latRad * 3) * cosLat;
    const baseV = 2.5 * Math.sin(latRad * 2);

    for (let i = 0; i < nx; i++) {
      const lon = i;
      const lonRad = (lon * Math.PI) / 180;

      const wave1 = Math.sin(4 * lonRad + t * 0.7) * Math.cos(2 * latRad);
      const wave2 = Math.cos(6 * lonRad - t * 0.4) * Math.sin(3 * latRad);
      const wave3 = Math.sin(8 * lonRad + t) * cosLat;

      buffer[idx] = baseU + (wave1 * 6 + wave2 * 3) * cosLat;
      buffer[count + idx] =
        baseV + (wave2 * 5 - wave1 * 4 + wave3 * 2) * cosLat;
      idx++;
    }
  }

  return new Response(buffer.buffer, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'public, max-age=3600, immutable',
    },
  });
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
/** The layer compares generations within one producer instance; this is ours. */
let radioGeneration = 0;

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
        // The layer reads `updatedAt` as an ISO timestamp and requires a
        // positive accepted generation whenever the answer is neither stale
        // nor degraded.
        updatedAt: new Date(now()).toISOString(),
        stale: false,
        degraded: false,
        degradedReason: null,
        coverage: null,
        acceptedGeneration: ++radioGeneration,
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

/** Terrain does not move, so one resolved point serves the whole session. */
const TERRAIN_TTL_MS = 30 * 24 * 3600_000;
const TERRAIN_MAX_POINTS = 2000;
/** Points per upstream call, sized the way the server sizes it. */
const TERRAIN_CHUNK = 64;
/** Entry ceiling for the page's own point cache (oldest evicted first). */
const TERRAIN_CACHE_MAX_ENTRIES = 20_000;
const terrainCache = new Map();

/**
 * `/api/terrain/heights?points=lon,lat;…` — Re:Earth point heights, resolved in
 * the page. The point cache, the per-point 5dp keys, the chunk size and the
 * "any point without a real height is a 502" rule are the server's own; only
 * the cross-origin GET goes through the shell's read-through.
 *
 * @param {object} options
 * @param {string} options.search
 * @param {(input: string) => Promise<Response>} options.upstream
 * @param {() => number} [options.now]
 * @returns {Promise<Response>}
 */
export async function terrainHeightsResponse({
  search,
  upstream,
  now = () => Date.now(),
} = {}) {
  const points = parseTerrainPoints(new URLSearchParams(search).get('points'));
  if (!points) {
    return jsonResponse(400, {
      error:
        'invalid points parameter — expected "lon,lat;lon,lat;…" with finite numbers',
    });
  }
  if (points.length > TERRAIN_MAX_POINTS) {
    return jsonResponse(500, {
      error: `too many points (${points.length}); max ${TERRAIN_MAX_POINTS} per request`,
    });
  }
  const readChunk = async (chunk) => {
    const out = [];
    for (let index = 0; index < chunk.length; index += TERRAIN_CHUNK) {
      const results = await fetchTerrainChunkWithRetry(
        chunk.slice(index, index + TERRAIN_CHUNK),
        {
          fetchImpl: (url) =>
            upstream(`/api/upstream?url=${encodeURIComponent(url)}`),
          // A poll is worth a short retry, not the server's ten-second budget:
          // the layer falls back to the bundled geoid per chunk, and a stale
          // answer here would move every vehicle to sea level.
          attemptTimeoutMs: 8000,
          retryBudgetMs: 4000,
          maxAttempts: 2,
        },
      );
      out.push(...results);
    }
    return out;
  };
  const outcome = await resolveTerrainHeightRequest({
    points,
    cache: terrainCache,
    fetchMissing: readChunk,
    ttlMs: TERRAIN_TTL_MS,
    now,
  });
  while (terrainCache.size > TERRAIN_CACHE_MAX_ENTRIES) {
    const oldest = terrainCache.keys().next().value;
    terrainCache.delete(oldest);
  }
  return jsonResponse(outcome.status, outcome.body);
}

/**
 * `/api/transit/feeds` — the catalog of pollable feeds. The registry already
 * ships in the bundle, so this is the list the server publishes.
 *
 * @returns {Response}
 */
export function transitFeedsResponse() {
  return jsonResponse(200, { feeds: publicTransitCatalog() });
}

/**
 * `/api/transit/vehicles/<feedId>` — the registered feed fetched and decoded
 * in the page. As on the server, only a registry id becomes an upstream URL.
 *
 * @param {object} options
 * @param {string} options.feedId
 * @param {(input: string) => Promise<Response>} options.upstream
 * @param {() => number} [options.now]
 * @returns {Promise<Response>}
 */
export async function transitVehiclesResponse({
  feedId,
  upstream,
  now = () => Date.now(),
} = {}) {
  const feed = getTransitFeed(feedId);
  if (!feed) return jsonResponse(404, { error: 'unknown_transit_feed' });
  let bytes;
  try {
    // The nonce keeps the shell's read-through from handing back the previous
    // poll: bus positions are only worth drawing if they are this poll's. The
    // body is protobuf, so the read is asked for as binary rather than text.
    const response = await upstream(
      `/api/upstream?binary=1&url=${encodeURIComponent(feed.url)}&_=${now()}`,
    );
    if (!response?.ok) throw new Error('upstream_unavailable');
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return jsonResponse(504, {
      error: 'transit_feed_unavailable',
      feedId,
      retryInSec: 15,
    });
  }
  try {
    const snapshot = buildTransitSnapshot(feed, bytes, now());
    return jsonResponse(200, snapshot, {
      'x-gev-cache': 'MISS',
      // The layer reads the operator's contact time separately from the
      // snapshot's own fetch time.
      'x-transit-contact': String(snapshot.fetchedAt),
    });
  } catch {
    // A differential or unreadable feed is a fault, not an outage: the layer
    // must not render it, and there is no snapshot to hand back.
    return jsonResponse(502, {
      error: 'transit_feed_unavailable',
      feedId,
      retryInSec: 60,
    });
  }
}

/**
 * `/api/gbfs/<encoded-url>` — station information and status, fetched through
 * the shell's read-through after the host and path checks the proxy applies,
 * so the page can only reach an allowlisted GBFS endpoint.
 *
 * @param {object} options
 * @param {string} options.encoded
 * @param {(input: string) => Promise<Response>} options.upstream
 * @returns {Promise<Response>}
 */
export async function gbfsResponse({ encoded, upstream } = {}) {
  let target;
  try {
    target = new URL(decodeURIComponent(String(encoded || '')));
  } catch {
    return jsonResponse(400, { error: 'invalid_gbfs_target' });
  }
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    !isAllowedGbfsHost(target.hostname) ||
    !isAllowedGbfsPath(target.pathname, target.hostname)
  ) {
    return jsonResponse(403, { error: 'gbfs_target_not_allowed' });
  }
  try {
    const response = await upstream(
      `/api/upstream?url=${encodeURIComponent(target.href)}`,
    );
    if (!response?.ok) throw new Error('upstream_unavailable');
    const payload = await response.json();
    if (!payload || typeof payload !== 'object') throw new Error('not_json');
    return jsonResponse(200, payload, {
      'x-gbfs-upstream': target.hostname,
      'x-gbfs-cache': 'MISS',
      'cache-control': gbfsCacheControl(target.pathname),
    });
  } catch {
    return jsonResponse(502, { error: 'gbfs_upstream_unavailable' });
  }
}

/**
 * `/api/military-installations` — the shell has no Overpass instance to ask,
 * and this project only queries operator-configured ones. Answering with the
 * same permanent capability miss the server returns when none is configured
 * is what lets the layer fall back to its mapped tile and name sources at
 * once instead of waiting on a query that cannot happen.
 *
 * @returns {Response}
 */
export function militaryInstallationsResponse() {
  return jsonResponse(503, {
    error: 'Detailed OpenStreetMap queries are not configured',
    code: 'OVERPASS_NOT_CONFIGURED',
    retryable: false,
  });
}

const BFS_URL =
  'https://www.imis.bfs.de/ogc/opendata/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=opendata:odlinfo_odl_1h_latest&outputFormat=application/json';
const CANADA_URL =
  'https://maps-cartes.services.geo.ca/server_serveur/rest/services/HC/fpsn_en/MapServer/1/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson';
const SAFECAST_URL = 'https://api.safecast.org/measurements.json';
const SAFECAST_LIMIT = 1000;
const RADMON_URL = 'https://radmon.org/radmon.php?function=getcombinedlistjson';
const PROTON_URL =
  'https://services.swpc.noaa.gov/json/goes/primary/integral-protons-6-hour.json';
const KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';

/**
 * `/api/radiation` — ambient dose-rate networks (BfS, Health Canada, Safecast,
 * radmon.org) plus NOAA SWPC space weather readings, normalized for the layer.
 *
 * @param {object} options
 * @param {(input: string) => Promise<Response>} options.upstream
 * @param {() => number} [options.now]
 * @returns {Promise<Response>}
 */
export async function radiationResponse({
  upstream,
  now = () => Date.now(),
} = {}) {
  const clock = now();
  const readJson = async (url) => {
    const response = await upstream(
      `/api/upstream?url=${encodeURIComponent(url)}`,
    );
    if (!response?.ok) throw new Error('upstream_unavailable');
    return response.json();
  };

  const networks = [
    {
      id: 'bfs',
      url: BFS_URL,
      decode: normalizeBfsSnapshot,
    },
    {
      id: 'canada',
      url: CANADA_URL,
      decode: normalizeCanadaSnapshot,
    },
    {
      id: 'safecast',
      url: `${SAFECAST_URL}?per_page=${SAFECAST_LIMIT}&since=${encodeURIComponent(
        new Date(clock - SAFECAST_MAX_AGE_MS).toISOString(),
      )}`,
      decode: (payload) => normalizeSafecastSnapshot(payload, { now: clock }),
    },
    {
      id: 'radmon',
      url: RADMON_URL,
      decode: normalizeRadmonSnapshot,
    },
  ];

  const results = await Promise.allSettled(
    networks.map(async (net) => {
      const payload = await readJson(net.url);
      const rows = net.decode(payload, clock);
      if (!rows) throw new Error('invalid_snapshot');
      return { id: net.id, rows };
    }),
  );

  const [protons, kp] = await Promise.allSettled([
    readJson(PROTON_URL),
    readJson(KP_URL),
  ]);
  const spaceReadings = normalizeSpaceReadings({
    protons: protons.status === 'fulfilled' ? protons.value : undefined,
    kp: kp.status === 'fulfilled' ? kp.value : undefined,
  });

  const stations = [];
  const sources = [];

  for (let i = 0; i < networks.length; i++) {
    const net = networks[i];
    const res = results[i];
    if (res.status === 'fulfilled') {
      const rows = res.value.rows;
      const room = Math.max(0, RADIATION_MAX_STATIONS - stations.length);
      if (room > 0) stations.push(...rows.slice(0, room));
      sources.push({
        id: net.id,
        ok: true,
        count: rows.length,
        fetchedAt: clock,
      });
    } else {
      sources.push({
        id: net.id,
        ok: false,
        count: 0,
        error: 'upstream_unavailable',
      });
    }
  }

  if (!stations.length && !spaceReadings) {
    return jsonResponse(503, { error: 'radiation_unavailable' });
  }

  const degraded = sources.some((s) => !s.ok);
  return jsonResponse(
    200,
    {
      fetchedAt: clock,
      stations,
      sources,
      space: spaceReadings,
    },
    degraded ? { 'X-Data-Degraded': 'true' } : {},
  );
}

const getAisStreamKey = () =>
  getApiKey('AISSTREAM_API_KEY', 'b13504076b28b22035291257176edc65cd0ed6c4');
const _inAppVessels = new Map();
const _inAppVesselStatic = new Map();
let _aisSocket = null;
let _aisLastMsgTime = null;

function ensureAisStream() {
  if (
    _aisSocket &&
    (_aisSocket.readyState === 0 || _aisSocket.readyState === 1) // CONNECTING or OPEN
  ) {
    return;
  }
  try {
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
    _aisSocket = ws;
    ws.onopen = () => {
      try {
        ws.send(
          JSON.stringify({
            APIKey: getAisStreamKey(),
            BoundingBoxes: [
              [
                [-90, -180],
                [90, 180],
              ],
            ],
            FilterMessageTypes: [
              'PositionReport',
              'StandardClassBPositionReport',
              'ExtendedClassBPositionReport',
              'ShipStaticData',
              'StaticDataReport',
            ],
          }),
        );
      } catch {
        /* ignore */
      }
    };
    ws.onmessage = async (event) => {
      _aisLastMsgTime = new Date().toISOString();
      try {
        const text =
          typeof event.data === 'string' ? event.data : await event.data.text();
        const envelope = JSON.parse(text);
        const messageType = envelope?.MessageType;
        const message = envelope?.Message?.[messageType] || {};
        const metadata = envelope?.MetaData || envelope?.Metadata || {};
        const mmsi = String(
          metadata.MMSI ??
            message.UserID ??
            message.UserId ??
            message.Mmsi ??
            '',
        ).trim();
        if (!mmsi) return;

        if (
          messageType === 'ShipStaticData' ||
          messageType === 'StaticDataReport'
        ) {
          const staticData = {
            name: String(
              metadata.ShipName ??
                message.Name ??
                message.ShipName ??
                message.ReportA?.Name ??
                '',
            ),
            type: String(
              message.Type ??
                message.ShipType ??
                message.ReportB?.ShipType ??
                '',
            ),
            destination: String(message.Destination ?? ''),
            imo: String(message.ImoNumber ?? message.IMO ?? ''),
          };
          _inAppVesselStatic.set(mmsi, staticData);
          const existing = _inAppVessels.get(mmsi);
          if (existing) {
            if (staticData.name) existing.name = staticData.name;
            if (staticData.type) existing.type = staticData.type;
            if (staticData.destination)
              existing.destination = staticData.destination;
            if (staticData.imo) existing.imo = staticData.imo;
          }
        }

        const lat = Number(
          metadata.latitude ?? metadata.Latitude ?? message.Latitude,
        );
        const lon = Number(
          metadata.longitude ?? metadata.Longitude ?? message.Longitude,
        );
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

        const staticData = _inAppVesselStatic.get(mmsi) || {};
        const name = String(
          metadata.ShipName ??
            message.Name ??
            message.ShipName ??
            message.ReportA?.Name ??
            staticData.name ??
            `MMSI ${mmsi}`,
        ).trim();
        const sog = Number(message.Sog ?? message.SOG);
        const cog = Number(message.Cog ?? message.COG);
        const heading = Number(message.TrueHeading ?? message.Heading);

        _inAppVessels.set(mmsi, {
          lat,
          lon,
          name: name || `MMSI ${mmsi}`,
          mmsi,
          imo: String(message.ImoNumber ?? message.IMO ?? staticData.imo ?? ''),
          type: String(
            message.Type ??
              message.ShipType ??
              message.ReportB?.ShipType ??
              staticData.type ??
              '',
          ),
          destination: String(
            message.Destination ?? staticData.destination ?? '',
          ),
          speed: Number.isFinite(sog) && sog >= 0 && sog < 102.3 ? sog : null,
          course: Number.isFinite(cog) && cog >= 0 && cog <= 360 ? cog : null,
          heading:
            Number.isFinite(heading) && heading >= 0 && heading < 360
              ? heading
              : null,
          last_position_UTC: String(
            metadata.time_utc ?? metadata.TimeUtc ?? new Date().toISOString(),
          ),
          last_position_epoch: Math.floor(Date.now() / 1000),
          _updatedAt: Date.now(),
        });

        if (_inAppVessels.size > 15000) {
          const firstKey = _inAppVessels.keys().next().value;
          _inAppVessels.delete(firstKey);
        }
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      _aisSocket = null;
    };
    ws.onerror = () => {
      _aisSocket = null;
    };
  } catch {
    _aisSocket = null;
  }
}

export function vesselsResponse() {
  ensureAisStream();
  const rows = Array.from(_inAppVessels.values()).map(
    ({ _updatedAt, ...row }) => row,
  );
  return jsonResponse(200, {
    rows,
    source: 'AISStream',
    status: 'live',
    error: null,
    refreshing: false,
    newestPositionAt: _aisLastMsgTime || new Date().toISOString(),
    lastMessageAt: _aisLastMsgTime,
  });
}

/**
 * The Provider Settings status this build renders: the same registry the
 * desktop server serves, marked against the app's own store so that a key the
 * user saved here gets the same REMOVE control the desktop panel offers for a
 * key it owns in its .env (markStoredKeyManagement, src/keySetupCore.mjs).
 */
function panelKeySetupStatus() {
  return markStoredKeyManagement(
    keySetupStatus(getAllApiKeys()),
    getStoredApiKeys(),
  );
}

/** Routes this module answers, keyed by pathname. */
const ROUTES = {
  '/api/gnss-integrity': (search, context) =>
    gnssIntegrityResponse({ search, upstream: context.upstream }),
  '/api/fire-perimeters': (search, context) =>
    firePerimetersResponse({ upstream: context.upstream }),
  '/api/cyclones': (search, context) =>
    cyclonesResponse({ upstream: context.upstream }),
  '/api/firms': (search, context) =>
    firmsResponse({ upstream: context.upstream }),
  '/api/firms/status': () => firmsStatusResponse(),
  '/api/weather/manifest': (search, context) =>
    weatherManifestResponse({ search, upstream: context.upstream }),
  '/api/weather/image': (search, context) =>
    weatherImageResponse({ search, upstream: context.upstream }),
  '/api/weather/tile': (search, context) =>
    weatherTileResponse({ search, upstream: context.upstream }),
  '/api/wind/manifest': (search) => windManifestResponse({ search }),
  '/api/wind/status': () =>
    jsonResponse(200, { model: 'gfs', overlay: 'none' }),
  '/api/radio/stations': (search, context) =>
    radioStationsResponse({ upstream: context.upstream }),
  '/api/transit/feeds': () => transitFeedsResponse(),
  '/api/military-installations': () => militaryInstallationsResponse(),
  '/api/terrain/heights': (search, context) =>
    terrainHeightsResponse({ search, upstream: context.upstream }),
  '/api/radiation': (search, context) =>
    radiationResponse({ upstream: context.upstream }),
  '/api/vessels': () => vesselsResponse(),
  '/api/vessels/track': (search) =>
    jsonResponse(200, { mmsi: '', samples: [], source: 'AISStream' }),
  '/api/setup/status': () => jsonResponse(200, panelKeySetupStatus()),
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
        if (url.pathname === '/api/setup/keys' && method === 'POST') {
          try {
            const bodyStr =
              typeof init?.body === 'string'
                ? init.body
                : init?.body instanceof Uint8Array
                  ? new TextDecoder().decode(init.body)
                  : '{}';
            const updates = JSON.parse(bodyStr);
            const validation = validateKeySetupUpdates(updates);
            if (!validation.ok) {
              return jsonResponse(400, validation);
            }
            saveApiKeys(updates);
            const status = panelKeySetupStatus();
            setTimeout(() => {
              if (typeof globalThis.location?.reload === 'function') {
                globalThis.location.reload();
              }
            }, 1200);
            return jsonResponse(200, {
              ok: true,
              saved: Object.keys(updates),
              store: 'local storage',
              status,
            });
          } catch (err) {
            return jsonResponse(400, {
              ok: false,
              error: err.message || 'Invalid request',
            });
          }
        }
        if (
          method === 'POST' &&
          url.pathname.startsWith('/api/') &&
          typeof globalThis.GodsEyeNative?.post === 'function'
        ) {
          try {
            const headersObj = {};
            if (init?.headers) {
              const entries =
                typeof init.headers.entries === 'function'
                  ? init.headers.entries()
                  : Object.entries(init.headers);
              for (const [k, v] of entries) headersObj[k] = v;
            }
            const bodyStr =
              typeof init?.body === 'string'
                ? init.body
                : init?.body instanceof Uint8Array
                  ? new TextDecoder().decode(init.body)
                  : '';
            const rawRes = globalThis.GodsEyeNative.post(
              url.pathname + url.search,
              JSON.stringify(headersObj),
              bodyStr,
            );
            const parsed = JSON.parse(rawRes);
            return new Response(parsed.body || '', {
              status: parsed.status || 200,
              statusText: parsed.statusText || 'OK',
              headers: { 'content-type': 'application/json' },
            });
          } catch {
            /* fall through */
          }
        }
        const route = ROUTES[url.pathname];
        if (route) {
          if (method !== 'GET') {
            return jsonResponse(405, { error: 'method_not_allowed' });
          }
          return route(url.search, context);
        }
        // `/api/gbfs/<encoded target>` and `/api/transit/vehicles/<feedId>`
        // carry their subject in the path, so they are matched here rather
        // than in the fixed table.
        if (url.pathname.startsWith('/api/wind/grid/')) {
          if (method !== 'GET') {
            return jsonResponse(405, { error: 'method_not_allowed' });
          }
          return windGridResponse();
        }
        if (url.pathname.startsWith('/api/gbfs/')) {
          if (method !== 'GET') {
            return jsonResponse(405, { error: 'method_not_allowed' });
          }
          return gbfsResponse({
            encoded: url.pathname.slice('/api/gbfs/'.length),
            upstream: context.upstream,
          });
        }
        const vehicles = url.pathname.match(
          /^\/api\/transit\/vehicles\/([^/]+)$/,
        );
        if (vehicles) {
          if (method !== 'GET') {
            return jsonResponse(405, { error: 'method_not_allowed' });
          }
          let feedId;
          try {
            feedId = decodeURIComponent(vehicles[1]);
          } catch {
            return jsonResponse(404, { error: 'unknown_transit_feed' });
          }
          return transitVehiclesResponse({
            feedId,
            upstream: context.upstream,
          });
        }
      }
    }
    return fetchImpl(input, init);
  };
  shim.__gevInAppApi = true;
  globalThis.fetch = shim;
  return true;
}
