import { lookup as dnsLookup } from 'node:dns/promises';
import { parseTapAddress } from '../../../src/data/tapAddress.js';
import { fetchFeedDocumentText } from '../local-receivers.js';

/**
 * Server-side aiscast proxy: a single operator-owned and validated URL
 * (ENV `AISCAST_URL`) is fetched with the same hardened rules as the local
 * receiver feeds (no redirects, DNS-resolved to the receiver-tap rule, pinned
 * socket, body capped while it streams) and its GeoJSON FeatureCollection is
 * normalized into the same `/api/vessels` snapshot shape as the resident
 * ais-live feeder. Responses are details-light (shape errors never carry
 * upstream text) and coalesced: parallel calls share one upstream attempt,
 * and the answered document is cached for AISCAST_CACHE_MS.
 */

export const AISCAST_ROUTE = '/api/vessels/aiscast';
export const AISCAST_URL_ENV = 'AISCAST_URL';
export const AISCAST_TIMEOUT_MS = 2000;
export const AISCAST_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const AISCAST_CACHE_MS = 1000;
/**
 * A document carrying explicit `time_utc` older than this reports itself as
 * stale, so the client-side freshness rule follows the same prefixed
 * staleness shape as the AIS streams. Feeds with no positions at all stay
 * outside this rule. It is not a substitute for live staleness in the layer —
 * that is the vessel layer's own job — it just keeps an idle ingester from
 * masquerading as an active one.
 */
export const AISCAST_STALE_MS = 30 * 60 * 1000;
/** Defensive cap on served rows; the viewport layer caps well below this. */
export const AISCAST_ROW_CAP = 50000;

/** Short status strings; the client detects their shape, never their text. */
const STATUS_SHORT = new Map(
  Object.entries({
    REDIRECT_REFUSED: 'refused redirect',
    HTTP_STATUS: 'upstream error status',
    RESPONSE_TOO_LARGE: 'body too large',
    TIMEOUT: 'timeout',
    UNRESOLVED: 'unresolved host',
    FORBIDDEN_ADDRESS: 'forbidden address',
    BAD_JSON: 'unparseable JSON body',
    BAD_DOCUMENT: 'not a GeoJSON FeatureCollection',
    UNREACHABLE: 'unreachable',
  }),
);

/**
 * Validate an `AISCAST_URL` value. Same rules as the receiver feeds: no path,
 * query, fragment or credentials; scheme http/https. The host must pass the
 * receiver-tap rule (loopback, private RFC-1918, localhost, or `*.local`).
 * The returned `url` is the validated absolute form used for all fetches; it
 * is rebuilt from the parsed host and port so a hostname like `localhost`
 * cannot be smuggled in as a numeric punying name (e.g. `0x7f.1`).
 * @param {unknown} value
 * @returns {{reason:string}|{url:string}} reason is English data (build setup
 * log); never shown translated — the setup message for its shape lives in the
 * browser at the connect page.
 */
export function parseAiscastUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { reason: 'expected a URL' };
  if (raw.includes('?') || raw.includes('#'))
    return { reason: 'query and fragment are not allowed' };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { reason: 'not a valid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { reason: 'scheme must be http or https' };
  if (url.username || url.password)
    return { reason: 'credentials are not allowed in the URL' };
  const port = url.port
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80;
  const address = parseTapAddress(`${url.hostname}:${port}`);
  if (!address)
    return {
      reason:
        'host must be loopback, RFC-1918 private, localhost, or a *.local name',
    };
  const path = `${url.pathname}${url.pathname.endsWith('/') ? '' : '/'}`;
  return { url: `${url.protocol}//${address.host}:${address.port}${path}` };
}

function firstDefined(props, names) {
  for (const name of names) {
    const value = props?.[name];
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return undefined;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Normalize a FeatureCollection into the `/api/vessels` payload rows. A
 * FeatureCollection with zero valid features is still a valid document — the
 * operator's ingester may just have no positions yet. Only one of the two
 * timestamp shapes is used; explicit `time_utc` takes precedence over a
 * numeric `last_position_epoch`.
 * @param {unknown} document Fetched JSON value.
 * @param {{now?: number}} [options]
 * @returns {{rows: object[], rawFeatureCount: number, newestPositionAtMs: number|null, status: 'live'|'stale'}}
 */
export function normalizeAiscastFeatureCollection(
  document,
  { now = Date.now() } = {},
) {
  if (
    !document ||
    typeof document !== 'object' ||
    document.type !== 'FeatureCollection' ||
    !Array.isArray(document.features)
  )
    throw new Error('expected a GeoJSON FeatureCollection');
  const rows = [];
  let newestPositionAtMs = null;
  for (const feature of document.features) {
    const geometry = feature?.geometry;
    const props = feature?.properties ?? {};
    const rawMmsi = String(firstDefined(props, ['mmsi', 'MMSI']) ?? '');
    const mmsi = rawMmsi.replace(/\D+/g, '');
    if (!mmsi || mmsi.length > 10) continue;
    const coordinates =
      geometry?.type === 'Point' ? geometry.coordinates : null;
    const longitude = finiteNumber(coordinates?.[0]);
    const latitude = finiteNumber(coordinates?.[1]);
    if (
      coordinates === null ||
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      longitude === null ||
      latitude === null ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    )
      continue;
    const utcText = firstDefined(props, [
      'time_utc',
      'last_heard',
      'last_heard_utc',
      'timestamp',
    ]);
    const parsedUtc = utcText !== undefined ? Date.parse(utcText) : NaN;
    const epochSeconds = Number.isFinite(parsedUtc)
      ? Math.floor(parsedUtc / 1000)
      : finiteNumber(
          firstDefined(props, [
            'last_position_epoch',
            'time_epoch',
            'unixtime',
          ]),
        );
    const observedAtMs = Number.isFinite(parsedUtc)
      ? parsedUtc
      : epochSeconds !== null
        ? epochSeconds * 1000
        : null;
    if (observedAtMs !== null)
      newestPositionAtMs =
        newestPositionAtMs === null
          ? observedAtMs
          : Math.max(newestPositionAtMs, observedAtMs);
    const row = {
      lat: latitude,
      lon: longitude,
      name:
        String(
          firstDefined(props, ['name', 'ship_name', 'shipName']) ?? '',
        ).trim() || `MMSI ${mmsi}`,
      mmsi,
      imo: String(firstDefined(props, ['imo']) ?? '').trim(),
      type: String(
        firstDefined(props, ['type', 'ship_type', 'shiptype']) ?? '',
      ).trim(),
      destination: String(firstDefined(props, ['destination']) ?? '').trim(),
      speed: finiteNumber(firstDefined(props, ['sog', 'speed'])),
      course: finiteNumber(firstDefined(props, ['cog', 'course'])),
      heading: finiteNumber(firstDefined(props, ['heading'])),
      // Same row shape as the resident ais-store feeder, so the browser-side
      // /api/vessels reader needs zero special cases. The UTC text is the
      // source of truth when present; an epoch-only feature still emits both.
      last_position_UTC: Number.isFinite(parsedUtc)
        ? new Date(parsedUtc).toISOString()
        : epochSeconds !== null
          ? new Date(epochSeconds * 1000).toISOString()
          : '',
      last_position_epoch: epochSeconds,
    };
    rows.push(row);
  }
  rows.sort(
    (left, right) =>
      (right.last_position_epoch ?? -Infinity) -
      (left.last_position_epoch ?? -Infinity),
  );
  const served = rows.slice(0, AISCAST_ROW_CAP);
  const status =
    newestPositionAtMs !== null && now - newestPositionAtMs > AISCAST_STALE_MS
      ? 'stale'
      : 'live';
  return {
    rows: served,
    rawFeatureCount: document.features.length,
    newestPositionAtMs,
    status,
  };
}

/**
 * Build the aiscast route handler and its local-dev server registration.
 * Nothing here reads a network value more often than the cache interval; the
 * route answers `configured:false` with no workspace reads otherwise.
 * @param {object} [options]
 * @param {string} [options.urlValue] Defaults to ENV `AISCAST_URL`.
 * @param {Function} [options.documentFetcher] Defaults to the shared hardened
 * feed fetch. Injectable for tests.
 * @param {ConsoleLike} [options.logger] Defaults to `console`.
 * @returns {{handle:function, config:{configured:boolean, url:string|null, reason:string|null}}}
 */
export function createAiscastHandler({
  urlValue = process.env[AISCAST_URL_ENV],
  documentFetcher = fetchFeedDocumentText,
  lookupImpl = dnsLookup,
  timeoutMs = AISCAST_TIMEOUT_MS,
  maxBytes = AISCAST_MAX_BODY_BYTES,
  logger = console,
} = {}) {
  const parsed = parseAiscastUrl(urlValue);
  const config = {
    configured: 'url' in parsed,
    url: parsed.url ?? null,
    reason: parsed.reason ?? null,
  };
  if (parsed.reason)
    logger.warn(
      `[aiscast] ${AISCAST_URL_ENV} rejected: ${parsed.reason}. It will not be fetched.`,
    );
  const cache = { payload: null, bestBefore: 0, promise: null };
  const cached = async (now) => {
    if (cache.payload && cache.bestBefore > now) return cache.payload;
    if (cache.promise) return cache.promise;
    cache.promise = (async () => {
      let payload;
      try {
        const text = await documentFetcher(config.url, {
          lookupImpl,
          timeoutMs,
          maxBytes,
        });
        let document;
        try {
          document = JSON.parse(text);
        } catch {
          payload = aiscastFailurePayload('BAD_JSON');
        }
        try {
          payload ??= buildAiscastPayload(
            normalizeAiscastFeatureCollection(document, { now: Date.now() }),
          );
        } catch {
          payload = aiscastFailurePayload('BAD_DOCUMENT');
        }
      } catch (error) {
        payload = aiscastFailurePayload(error?.code ?? 'UNREACHABLE');
      }
      // Even failures are cached, so a failing upstream sees at most one
      // request per cache interval instead of one per inbound request.
      cache.payload = payload;
      cache.bestBefore = Date.now() + AISCAST_CACHE_MS;
      return payload;
    })();
    try {
      return await cache.promise;
    } finally {
      cache.promise = null;
    }
  };
  function handle(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405;
      response.setHeader('Allow', 'GET, HEAD');
      response.end();
      return;
    }
    if (!config.configured) {
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'no-store');
      if (request.method === 'GET')
        response.end(
          JSON.stringify(aiscastFailurePayload(null, { configured: false })),
        );
      else response.end();
      return;
    }
    void (async () => {
      let payload;
      try {
        payload = await cached(Date.now());
      } catch {
        payload = aiscastFailurePayload('UNREACHABLE');
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'no-store');
      if (request.method === 'GET') response.end(JSON.stringify(payload));
      else response.end();
    })();
  }
  return { handle, config };
}

function aiscastFailurePayload(errorCode, { configured = true } = {}) {
  return {
    source: 'Aiscast',
    configured,
    status: 'unavailable',
    error:
      errorCode === null
        ? null
        : (STATUS_SHORT.get(errorCode) ?? 'unreachable'),
    rows: [],
    rawFeatureCount: 0,
    rejectedCount: 0,
    newestPositionAtMs: null,
    staleAfterMs: AISCAST_STALE_MS,
    generatedAt: Date.now(),
  };
}

function buildAiscastPayload({
  rows,
  rawFeatureCount,
  newestPositionAtMs,
  status,
}) {
  return {
    source: 'Aiscast',
    configured: true,
    status,
    error: null,
    rows,
    rawFeatureCount,
    rejectedCount: Math.max(0, rawFeatureCount - rows.length),
    newestPositionAtMs,
    staleAfterMs: AISCAST_STALE_MS,
    generatedAt: Date.now(),
  };
}

/**
 * Vite plugin for the local dev and Electron backend. Mounted in
 * `server/providers/local.js`.
 */
export function aiscastProxy({
  urlValue = process.env[AISCAST_URL_ENV],
  logger = console,
} = {}) {
  const { handle } = createAiscastHandler({ urlValue, logger });
  return {
    name: 'aiscast-proxy',
    configureServer(server) {
      server.middlewares.use(AISCAST_ROUTE, (request, response, next) => {
        if (request.url !== '/' && request.url !== '') return next();
        handle(request, response);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(AISCAST_ROUTE, (request, response, next) => {
        if (request.url !== '/' && request.url !== '') return next();
        handle(request, response);
      });
    },
  };
}
