import {
  normalizeEffisCollection,
  normalizeEmsActivationList,
  normalizeGdacsEventList,
} from './records.js';

/** The upstream GDACS events API (no key, GeoJSON pages). The read was
 * written against a CORS-open API; gdacs.org stopped sending the CORS header,
 * so a browser-direct read is refused everywhere — the page fetch falls back
 * onto the app's own relay (see readGdacsPage below). */
const GDACS_BASE_URL =
  'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';

/** All disaster-relevant GDACS hazard types; semicolon-separated upstream. */
export const GDACS_EVENT_TYPES = 'EQ;TC;VO;FL;WF;DR';

/** GDACS caps one page at 100 rows; three pages bound the read worst case. */
export const GDACS_PAGE_SIZE = 100;
export const GDACS_MAX_EVENTS = 300;

/** Why a copy-on-write query string for the EFFIS WFS outputFormat matters. */
const EFFIS_WFS_BASE = 'https://maps.effis.emergency.copernicus.eu/effis/ows';
/** The week layer is already upstream-scoped; keep one small read. */
export const EFFIS_TYPE_NAME = 'ms:modis.ba.poly.week';
export const EFFIS_MAX_FEATURES = 500;
/** MapServer requires this exact string, space after the semicolon. */
const EFFIS_OUTPUT_FORMAT = 'application/json; subtype=geojson';

/** The app's own server proxy for the no-CORS Copernicus activations API. */
export const COPERNICUS_EMS_API_PATH = '/api/copernicus-ems';
export const COPERNICUS_EMS_UPSTREAM_URL =
  'https://mapping.emergency.copernicus.eu/activations/api/activations/';
export const COPERNICUS_EMS_LIMIT = 200;

/** Build the GDACS current-events read for one page (query params only). */
export function buildGdacsQueryUrl({ pageNumber = 1 } = {}) {
  const params = new URLSearchParams({
    eventlist: GDACS_EVENT_TYPES,
    pageSize: String(GDACS_PAGE_SIZE),
    pageNumber: String(pageNumber),
  });
  return `${GDACS_BASE_URL}?${params}`;
}

/** Build the app's Copernicus EMS proxy read. */
export function buildEmsActivationsUrl({
  path = COPERNICUS_EMS_API_PATH,
} = {}) {
  return `${path}`;
}

/** Build the EFFIS WFS GetFeature read for a burnt-area feature type. */
export function buildEffisWfsUrl({
  typeName = EFFIS_TYPE_NAME,
  count = EFFIS_MAX_FEATURES,
  base = EFFIS_WFS_BASE,
} = {}) {
  const params = new URLSearchParams({
    service: 'WFS',
    version: '2.0.0',
    request: 'GetFeature',
    typeNames: typeName,
    count: String(count),
    outputFormat: EFFIS_OUTPUT_FORMAT,
  });
  return `${base}?${params}`;
}

/** The app's own byte relay for a cross-origin read the browser refuses.
 * Served on desktop and preview by server/providers/upstream.js (the route is
 * pinned to the GDACS host there) and inside the Android shell by LiveApi
 * (www.gdacs.org in its fixed host list). */
export const UPSTREAM_API_PATH = '/api/upstream';

/** Relay a browser-refused cross-origin read through the app's own upstream. */
export function buildUpstreamUrl(target) {
  return `${UPSTREAM_API_PATH}?url=${encodeURIComponent(target)}`;
}

/**
 * Read one GDACS page. The browser-direct attempt stays first: the snapshot is
 * sync-healthy where the API still sends CORS headers. Where it does not, the
 * fetch itself rejects ("Failed to fetch"), and that is the one failure the
 * relay answers: appassets origins with the shell, the served console with the
 * Node server.
 */
export async function readGdacsPage(
  url,
  { signal, fetchImpl = (...args) => globalThis.fetch(...args) } = {},
) {
  let response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    response = await fetchImpl(buildUpstreamUrl(url), { signal });
  }
  if (!response.ok) throw new Error(`GDACS HTTP ${response.status}`);
  return response.json();
}

/**
 * Request and validate complete feed snapshots before replacing the display.
 *
 * GDACS is the primary: its failure fails the snapshot; the Copernicus EMS
 * activation list (read through the app's own server proxy, because that API
 * sends no CORS headers) and the EFFIS burnt-area perimeters (read
 * browser-direct; the endpoint is CORS-open) are complements — when one of
 * them answers an unusable snapshot the other still hydrates the layer, and
 * the unavailable one is simply missing from the rows, like an empty feed.
 */
export function createGlobalDisastersSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  gdacsMaxEvents = GDACS_MAX_EVENTS,
  emsPath = COPERNICUS_EMS_API_PATH,
  effisTypeName = EFFIS_TYPE_NAME,
  effisMaxFeatures = EFFIS_MAX_FEATURES,
} = {}) {
  const fetchJson = async (url, { signal } = {}) => {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    signal?.throwIfAborted();
    return response.json();
  };

  const readGdacs = async ({ signal } = {}) => {
    signal?.throwIfAborted();
    const rows = [];
    for (let pageNumber = 1; rows.length < gdacsMaxEvents; pageNumber++) {
      const url = buildGdacsQueryUrl({ pageNumber });
      const payload = await readGdacsPage(url, { signal, fetchImpl });
      signal?.throwIfAborted();
      const normalized = normalizeGdacsEventList(payload, { now: now() });
      if (!normalized) throw new Error('Malformed GDACS response');
      rows.push(...normalized.rows);
      if (payload.features.length < GDACS_PAGE_SIZE) break;
      if (pageNumber > 10) break;
    }
    return rows.slice(0, gdacsMaxEvents);
  };

  /** Complement failures never fail the snapshot; they only thin the layer. */
  const readComplement = async (url, normalize, options) => {
    try {
      const payload = await fetchJson(url, options);
      const normalized = normalize(payload, { now: now() });
      if (!normalized) throw new Error('malformed');
      return normalized.rows;
    } catch {
      return [];
    }
  };

  return {
    async getSnapshot({ signal } = {}) {
      const events = await readGdacs({ signal });
      signal?.throwIfAborted();
      const [activations, fires] = await Promise.all([
        readComplement(
          buildEmsActivationsUrl({ path: emsPath }),
          normalizeEmsActivationList,
          { signal },
        ),
        readComplement(
          buildEffisWfsUrl({
            typeName: effisTypeName,
            count: effisMaxFeatures,
          }),
          normalizeEffisCollection,
          { signal },
        ),
      ]);
      return [
        ...events,
        ...activations,
        // EFFIS perimeters are per-week everywhere; show the largest burnt
        // areas last so point events read first on shared screen space.
        ...fires.sort(
          (left, right) => (right.areaHa ?? 0) - (left.areaHa ?? 0),
        ),
      ];
    },
  };
}
