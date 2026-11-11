import { readCappedResponseText } from './common/http.js';
import {
  MAX_INSIDER_FILINGS,
  parseSecAtomFeed,
} from '../../src/layers/insider/records.js';

/**
 * SEC EDGAR latest-filings proxy (Form 4 ownership reports).
 *
 * EDGAR requires a declared User-Agent and sends no CORS headers, so the
 * browser cannot read the Atom feed directly. The route fetches the feed,
 * groups each filing's issuer/reporting entries, and answers prepared rows.
 *
 * Without a real contact in SEC_EDGAR_USER_AGENT the SEC may throttle or block
 * the caller, so the default keeps a project identifier and asks the operator
 * to set a contact address.
 *
 * Route: GET /api/insider
 * Upstream: https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent
 */

export const INSIDER_ROUTE = '/api/insider';
export const INSIDER_TIMEOUT_MS = 15_000;
export const INSIDER_MAX_BYTES = 4 * 1024 * 1024;
export const INSIDER_CACHE_MS = 5 * 60 * 1000;
export const INSIDER_COUNT = MAX_INSIDER_FILINGS;
export const DEFAULT_EDGAR_USER_AGENT =
  'gods-eye-view/0.3 (set SEC_EDGAR_USER_AGENT with a contact address)';

export function buildInsiderUrl({ count = INSIDER_COUNT } = {}) {
  const params = new URLSearchParams({
    action: 'getcurrent',
    type: '4',
    company: '',
    dateb: '',
    owner: 'include',
    count: String(Math.min(Math.max(count, 1), 400)),
    output: 'atom',
  });
  return `https://www.sec.gov/cgi-bin/browse-edgar?${params.toString()}`;
}

export function insiderFailure(errorCode, { generatedAt = Date.now() } = {}) {
  return { ok: false, rows: [], error: errorCode, generatedAt };
}

export function createInsiderHandler({
  fetchImpl = (...args) => globalThis.fetch(...args),
  userAgent = process.env.SEC_EDGAR_USER_AGENT || DEFAULT_EDGAR_USER_AGENT,
  timeoutMs = INSIDER_TIMEOUT_MS,
  maxBytes = INSIDER_MAX_BYTES,
  cacheMs = INSIDER_CACHE_MS,
  count = INSIDER_COUNT,
  logger = console,
  now = Date.now,
} = {}) {
  const cache = { payload: null, bestBefore: 0, promise: null };

  const readUpstream = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const upstream = await fetchImpl(buildInsiderUrl({ count }), {
        signal: controller.signal,
        headers: {
          'user-agent': userAgent,
          accept: 'application/atom+xml, application/xml, text/xml',
          'accept-encoding': 'gzip, deflate',
        },
      });
      if (!upstream.ok) return insiderFailure(`upstream ${upstream.status}`);
      const { tooLarge, text } = await readCappedResponseText(
        upstream,
        maxBytes,
      );
      if (tooLarge) return insiderFailure('body-too-large');
      const parsed = parseSecAtomFeed(text);
      if (!parsed) return insiderFailure('unparseable');
      return {
        ok: true,
        rows: parsed.rows,
        updatedAt: parsed.updatedAt,
        error: null,
        generatedAt: now(),
      };
    } catch (error) {
      logger.warn?.(
        `[insider] upstream read failed: ${error?.name ?? 'Error'}`,
      );
      return insiderFailure('upstream');
    } finally {
      clearTimeout(timer);
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
        payload = insiderFailure('upstream');
      }
      response.statusCode = payload.ok ? 200 : 503;
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'no-store');
      if (request.method === 'GET') response.end(JSON.stringify(payload));
      else response.end();
    },
  };
}

export function insiderProxy({ logger = console } = {}) {
  const { handle } = createInsiderHandler({ logger });
  const mount = (server) => {
    server.middlewares.use(INSIDER_ROUTE, (request, response, next) => {
      if (request.url !== '/' && request.url !== '') return next();
      void handle(request, response);
    });
  };
  return {
    name: 'insider-proxy',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
