import { readCappedResponseText } from './common/http.js';
import { makeCostRateLimiter, clientKey } from './common/rate-limit.js';
import { sameSiteGated } from './common/same-site.js';

/**
 * Optional OSINT search proxy on Valyu (https://docs.valyu.ai) — a paid,
 * credit-metered news/web search the operator may point at geopolitical
 * questions the primary feeds cannot answer. It is a complement to the app's
 * real data sources, never a replacement: every query costs operator credits,
 * so the route is cross-site gated with the same per-IP budget as the other
 * cost-bearing relays and the permanent key stays on Node.
 *
 * Keyless behavior mirrors the other cost-bearing relays: a missing
 * `VALYU_API_KEY` is a keyless 503 `{ok:false, error:'not-configured'}`, so a
 * caller degrades to the in-app sources instead of retrying a dead endpoint.
 *
 * Route: GET /api/valyu/events?query=...[&maxNumResults=6][&startDate=YYYY-MM-DD]
 * Upstream: POST https://api.valyu.ai/v1/search  (x-api-key header)
 */

export const VALYU_EVENTS_ROUTE = '/api/valyu/events';
export const VALYU_TIMEOUT_MS = 30_000;
export const VALYU_MAX_BYTES = 3 * 1024 * 1024;
export const VALYU_MAX_RESULTS = 10;
export const VALYU_DEFAULT_RESULTS = 6;
export const VALYU_RATE_PER_MIN_DEFAULT = 10;

export function valyuFailure(errorCode, { generatedAt = Date.now() } = {}) {
  return {
    ok: false,
    error: errorCode, // 'not-configured' | 'auth' | 'credits' | `upstream <n>` | 'unparseable' | 'upstream'
    events: [],
    generatedAt,
  };
}

function normalizeEvent(result) {
  if (!result || typeof result !== 'object') return null;
  const title = typeof result.title === 'string' ? result.title.trim() : '';
  const url = typeof result.url === 'string' ? result.url.trim() : '';
  if (!title || !/^https?:\/\//.test(url)) return null;
  const publicationDate = new Date(result.publication_date ?? NaN);
  return {
    title,
    url,
    source: typeof result.source === 'string' ? result.source : '',
    summary: typeof result.content === 'string' ? result.content : '',
    publicationDate: Number.isNaN(publicationDate.getTime())
      ? null
      : publicationDate.toISOString(),
  };
}

// Like the other cost-bearing limiters, built lazily on first request so a
// late-applied `.env` is visible.
let _rateLimiter;

function valyuRateLimiter() {
  if (_rateLimiter === undefined)
    _rateLimiter = makeCostRateLimiter(
      process.env.GEV_RATELIMIT_VALYU_PER_MIN,
      VALYU_RATE_PER_MIN_DEFAULT,
    );
  return _rateLimiter;
}

/** Apply the per-IP limiter, writing a 429 when over the cap. */
function enforceRateLimit(limiter, req, res) {
  if (!limiter) return true; // explicit 0 opt-out — unthrottled
  if (limiter(clientKey(req))) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Retry-After', '5');
  res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  return false;
}

export function createValyuEventsHandler({
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiKey = process.env.VALYU_API_KEY,
  timeoutMs = VALYU_TIMEOUT_MS,
  maxBytes = VALYU_MAX_BYTES,
  rateLimiter = valyuRateLimiter,
  logger = console,
} = {}) {
  return {
    async handle(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      const send = (statusCode, payload) => {
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'GET') res.end(JSON.stringify(payload));
        else res.end();
      };

      // Evaluated per call so a late-applied `.env` is visible without a
      // restart.
      const effectiveKey = apiKey ?? process.env.VALYU_API_KEY;
      if (!effectiveKey) {
        send(503, valyuFailure('not-configured'));
        return;
      }

      if (!enforceRateLimit(rateLimiter(), req, res)) return;

      const params = new URL(req.url, 'http://local').searchParams;
      const query = (params.get('query') ?? '').trim();
      if (!query) {
        send(400, { ok: false, error: 'Missing query' });
        return;
      }
      const parsed = Number.parseInt(params.get('maxNumResults') ?? '', 10);
      const clamped = Math.min(
        Math.max(Number.isNaN(parsed) ? VALYU_DEFAULT_RESULTS : parsed, 1),
        VALYU_MAX_RESULTS,
      );
      const startDate = (params.get('startDate') ?? '').trim();

      const body = {
        query,
        max_num_results: clamped,
        search_type: 'news',
        is_tool_call: true,
      };
      if (startDate) body.start_date = startDate;

      let upstream;
      try {
        upstream = await fetchImpl('https://api.valyu.ai/v1/search', {
          method: 'POST',
          headers: {
            'x-api-key': effectiveKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        logger.warn?.(
          `[valyu] upstream read failed: ${error?.name ?? 'Error'}`,
        );
        send(200, valyuFailure('upstream'));
        return;
      }

      if (!upstream.ok) {
        const status = upstream.status;
        const code =
          status === 401 || status === 403
            ? 'auth'
            : status === 402
              ? 'credits'
              : `upstream ${status}`;
        if (code === 'auth' || code === 'credits')
          console.warn(`[valyu] upstream HTTP ${status}`);
        send(200, valyuFailure(code));
        return;
      }

      const { tooLarge, text } = await readCappedResponseText(
        upstream,
        maxBytes,
      );
      if (tooLarge) {
        send(200, valyuFailure('upstream'));
        return;
      }
      let document;
      try {
        document = JSON.parse(text);
      } catch {
        send(200, valyuFailure('unparseable'));
        return;
      }
      if (document?.success !== true || !Array.isArray(document.results)) {
        send(200, valyuFailure('unparseable'));
        return;
      }
      const events = document.results
        .map(normalizeEvent)
        .filter((event) => event !== null);
      send(200, { ok: true, error: null, events, generatedAt: Date.now() });
    },
  };
}

export function valyuEventsProxy({ logger = console } = {}) {
  const { handle } = createValyuEventsHandler({ logger });
  const gated = sameSiteGated(handle);
  return {
    name: 'valyu-events-proxy',
    configureServer(server) {
      server.middlewares.use(VALYU_EVENTS_ROUTE, gated);
    },
    configurePreviewServer(server) {
      server.middlewares.use(VALYU_EVENTS_ROUTE, gated);
    },
  };
}
