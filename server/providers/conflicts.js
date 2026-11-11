import { readCappedResponseText } from './common/http.js';

/**
 * Conflict-events proxy.
 *
 * ACLED moved in 2025 and this route follows the new shape, not the old one:
 *  - the key-based `api.acleddata.com/acled/read?key=…&email=…` endpoint is
 *    retired (it no longer resolves in DNS) and its keys stopped being issued;
 *  - authentication is now an OAuth password grant at `acleddata.com/oauth/token`
 *    returning a 24 h bearer token, and the data lives at
 *    `acleddata.com/api/acled/read`.
 *
 * There is deliberately NO keyless fallback: GDELT's GeoJSON modes are dead
 * ("Invalid format" on DOC 2.0, 404 on GEO 2.0), and answering with an empty
 * world would be worse than saying nothing. Without credentials the route
 * reports `no_key` and the layer panel shows that state.
 *
 * Route: GET /api/conflicts
 */

export const CONFLICTS_ROUTE = '/api/conflicts';
export const CONFLICTS_TIMEOUT_MS = 15_000;
export const CONFLICTS_MAX_BYTES = 8 * 1024 * 1024;
export const CONFLICTS_CACHE_MS = 10 * 60 * 1000;
export const ACLED_LIMIT = 2000;
export const ACLED_TOKEN_URL = 'https://acleddata.com/oauth/token';
export const ACLED_UPSTREAM_URL = 'https://acleddata.com/api/acled/read';
export const ACLED_CLIENT_ID = 'acled';
export const CONFLICTS_WINDOW_DAYS = 7;
/** Refresh the bearer token this long before it expires. */
const TOKEN_SKEW_MS = 60_000;

/** Field list keeps the ACLED payload small enough to cache comfortably. */
const ACLED_FIELDS = [
  'event_id_cnty',
  'event_date',
  'event_type',
  'sub_event_type',
  'actor1',
  'actor2',
  'fatalities',
  'latitude',
  'longitude',
  'country',
].join('|');

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Trailing window ACLED expects as `event_date=BETWEEN start|end`. */
export function conflictWindow(now = Date.now(), days = CONFLICTS_WINDOW_DAYS) {
  return {
    start: isoDay(now - days * 86_400_000),
    end: isoDay(now),
  };
}

/** Data URL. Credentials never travel in the query string any more. */
export function buildAcledUrl({ start, end, limit = ACLED_LIMIT }) {
  const params = new URLSearchParams({
    _format: 'json',
    limit: String(limit),
    fields: ACLED_FIELDS,
    event_date: `${start}|${end}`,
    event_date_where: 'BETWEEN',
  });
  return `${ACLED_UPSTREAM_URL}?${params.toString()}`;
}

/** OAuth password-grant body, exactly as ACLED documents it. */
export function buildTokenBody({ email, password }) {
  return new URLSearchParams({
    username: email,
    password,
    grant_type: 'password',
    client_id: ACLED_CLIENT_ID,
    scope: 'authenticated',
  }).toString();
}

export function conflictsFailure(errorCode, { generatedAt = Date.now() } = {}) {
  return { ok: false, provider: null, error: errorCode, generatedAt };
}

export function createConflictsHandler({
  fetchImpl = (...args) => globalThis.fetch(...args),
  acledEmail,
  acledPassword,
  timeoutMs = CONFLICTS_TIMEOUT_MS,
  maxBytes = CONFLICTS_MAX_BYTES,
  cacheMs = CONFLICTS_CACHE_MS,
  logger = console,
  now = Date.now,
} = {}) {
  const cache = { payload: null, bestBefore: 0, promise: null };
  const token = { value: null, bestBefore: 0, promise: null };

  // Vite copies .env into process.env in its config hook, after this module and
  // the plugin that builds the handler have been evaluated. Credentials are
  // therefore resolved per request: adding ACLED_EMAIL to .env applies on the
  // next read instead of requiring the value to exist at construction time.
  const credentials = () => ({
    email: acledEmail ?? process.env.ACLED_EMAIL,
    password: acledPassword ?? process.env.ACLED_PASSWORD,
  });

  const withTimeout = async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const readJson = async (response) => {
    const { tooLarge, text } = await readCappedResponseText(response, maxBytes);
    if (tooLarge) return { error: 'body-too-large' };
    try {
      return { document: JSON.parse(text) };
    } catch {
      return { error: 'unparseable' };
    }
  };

  const coded = (code, message = code) =>
    Object.assign(new Error(message), { code });

  const requestToken = async () => {
    const response = await withTimeout(ACLED_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: buildTokenBody(credentials()),
    });
    if (!response.ok) throw coded(`token ${response.status}`);
    const { document, error } = await readJson(response);
    if (error) throw coded(error);
    const value = document?.access_token;
    if (typeof value !== 'string' || !value) throw coded('unparseable');
    const ttlMs =
      Number(document.expires_in) > 0
        ? Number(document.expires_in) * 1000
        : TOKEN_SKEW_MS * 2;
    token.value = value;
    token.bestBefore = now() + Math.max(TOKEN_SKEW_MS, ttlMs - TOKEN_SKEW_MS);
    return value;
  };

  const accessToken = async () => {
    if (token.value && token.bestBefore > now()) return token.value;
    if (token.promise) return token.promise;
    token.promise = requestToken();
    try {
      return await token.promise;
    } finally {
      token.promise = null;
    }
  };

  const readData = async (bearer) => {
    const { start, end } = conflictWindow(now());
    const response = await withTimeout(buildAcledUrl({ start, end }), {
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: 'application/json',
      },
    });
    if (response.status === 401) return { unauthorized: true };
    if (!response.ok) return { error: `upstream ${response.status}` };
    const { document, error } = await readJson(response);
    if (error) return { error };
    if (!Array.isArray(document?.data)) return { error: 'unparseable' };
    return { data: document.data };
  };

  const readUpstream = async () => {
    const { email, password } = credentials();
    if (!email || !password) return conflictsFailure('no_key');
    try {
      let result = await readData(await accessToken());
      if (result.unauthorized) {
        // An expired or revoked bearer token is worth exactly one retry.
        token.value = null;
        token.bestBefore = 0;
        result = await readData(await accessToken());
        if (result.unauthorized) return conflictsFailure('unauthorized');
      }
      if (result.error) return conflictsFailure(result.error);
      return {
        ok: true,
        provider: 'acled',
        error: null,
        data: result.data,
        generatedAt: now(),
      };
    } catch (error) {
      const code = String(error?.code ?? '');
      logger.warn?.(`[conflicts] upstream read failed: ${code || 'Error'}`);
      if (code === 'unparseable') return conflictsFailure('unparseable');
      if (code.startsWith('token ')) return conflictsFailure('auth');
      return conflictsFailure('upstream');
    }
  };

  const cached = async () => {
    const at = now();
    if (cache.payload && cache.bestBefore > at) return cache.payload;
    if (cache.promise) return cache.promise;
    cache.promise = (async () => {
      const payload = await readUpstream();
      if (payload.ok) {
        cache.payload = payload;
        cache.bestBefore = now() + cacheMs;
      }
      return payload;
    })();
    try {
      return await cache.promise;
    } finally {
      cache.promise = null;
    }
  };

  return {
    async handle(request, response) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.statusCode = 405;
        response.setHeader('Allow', 'GET, HEAD');
        response.end();
        return;
      }
      let payload;
      try {
        payload = await cached();
      } catch {
        payload = conflictsFailure('upstream');
      }
      response.statusCode = payload.ok ? 200 : 503;
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'no-store');
      if (request.method === 'GET') response.end(JSON.stringify(payload));
      else response.end();
    },
  };
}

export function conflictsProxy({ logger = console } = {}) {
  const { handle } = createConflictsHandler({ logger });
  const mount = (server) => {
    server.middlewares.use(CONFLICTS_ROUTE, (request, response, next) => {
      if (request.url !== '/' && request.url !== '') return next();
      void handle(request, response);
    });
  };
  return {
    name: 'conflicts-proxy',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
