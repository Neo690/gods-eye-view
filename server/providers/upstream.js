import { TRANSIT_ENABLED_FEEDS } from '../../src/data/transitFeeds.js';
import { readResponseBytesCapped } from './common/http.js';
import { makeCostRateLimiter, clientKey } from './common/rate-limit.js';

/**
 * The one upstream the standalone shell cannot reach itself.
 *
 * The APK serves the bundle from `https://appassets.androidplatform.net`, so a
 * layer's `fetch('/api/…')` hits the asset store and 404s. The shell replays
 * those calls against this server (see `ApiForwarder.java`), and for the feeds
 * that send no CORS headers it also asks for the *bytes*: `/api/upstream?url=…`
 * is that door, and the in-page API in `src/data/inAppApi.js` has always
 * expected it to exist.
 *
 * It is a deliberately narrow door, not an open proxy:
 *  - only GET, and only the exact URLs this build's transit registry publishes
 *    (plus the pinned floor and OpenFreeMap tile routes below), so a request
 *    cannot name a host the catalogue never cleared (no SSRF);
 *  - https only, no credentials, no non-standard port, no fragment;
 *  - no redirects followed — an allow-listed URL cannot bounce the relay
 *    somewhere else;
 *  - a hard body cap enforced while reading and a request deadline;
 *  - per-IP throttle, because the phone retries and nobody else should.
 *
 * Adding a dataset is adding its URL to the registry it belongs to — never a
 * wildcard here.
 */

/**
 * Upstreams the shell needs that the transit registry does not name.
 *
 * A transit vehicle is not shown until a ground floor resolves — a sprite
 * parked at sea level under a hill is worse than no sprite — and the page asks
 * for those floors through this same relay. The footprint is a single host and
 * path whose only variable is the `points` query, so the route is pinned by
 * origin and path rather than by exact URL.
 *
 * Street geometry is the second: the traffic and mapped-installation layers
 * read OpenFreeMap vector tiles, and in the shell that read is cross-origin.
 * On the phone it did not fail fast — it hung past the road pass deadline — so
 * the bytes are fetched here instead, from a datacentre that reaches
 * OpenFreeMap normally.
 */
const EXTRA_ROUTES = Object.freeze([
  Object.freeze({
    origin: 'https://terrain.reearth.land',
    pathname: '/heights.json',
  }),
  /** The TileJSON document: it names the tile version currently published. */
  Object.freeze({
    origin: 'https://tiles.openfreemap.org',
    pathname: '/planet',
  }),
  /**
   * A planet tile. OpenFreeMap versions its path per build
   * (`/planet/20261018_080001_pt/{z}/{x}/{y}.pbf`), so this route cannot be an
   * exact URL: it is one host and the tile shape alone — a version segment,
   * three integer coordinates and the `.pbf` suffix. Nothing else under that
   * host is reachable.
   */
  Object.freeze({
    origin: 'https://tiles.openfreemap.org',
    pattern: /^\/planet\/[0-9A-Za-z_]+\/\d{1,5}\/\d{1,5}\/\d{1,5}\.pbf$/,
  }),
]);

const TIMEOUT_MS = 15_000;
/** The largest registered feed is well under 1 MB; this is a hard ceiling. */
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;
const DEFAULT_PER_MINUTE = 120;

/**
 * Every upstream this relay will fetch, as normalized hrefs.
 *
 * Built from the *enabled* registry: a feed the owner has switched off is not
 * reachable through a hand-written query either.
 * @returns {Set<string>}
 */
export function allowedUpstreamUrls() {
  const allowed = new Set();
  for (const feed of TRANSIT_ENABLED_FEEDS) {
    try {
      allowed.add(new URL(feed.url).href);
    } catch {
      /* a malformed registry row is a build-time fault, not a request fault */
    }
  }
  return allowed;
}

/** The pinned origin+path routes, for the tests that hold the list still. */
export const UPSTREAM_EXTRA_ROUTES = EXTRA_ROUTES;

const ALLOWED = allowedUpstreamUrls();

/**
 * Whether a request's `url` may be relayed: an exact, already-cleared URL.
 * @param {unknown} raw
 * @param {Set<string>} [allowed]
 * @returns {string|null} The normalized href to fetch, or null.
 */
export function relayTarget(raw, allowed = ALLOWED) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (raw.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // A registered feed is on the default https port; anything else is a way to
  // probe a service this relay was never meant to speak to.
  if (url.port && url.port !== '443') return null;
  if (url.hash) return null;
  if (allowed.has(url.href)) return url.href;
  // A pinned origin+path is still a cleared upstream: only the query, which
  // names points or a tile rather than a destination, is free.
  const route = EXTRA_ROUTES.some(
    (entry) =>
      entry.origin === url.origin &&
      (entry.pattern
        ? entry.pattern.test(url.pathname)
        : entry.pathname === url.pathname),
  );
  return route ? url.href : null;
}

/**
 * Bounded, allow-listed relay for the standalone shell.
 * @param {object} [options]
 * @param {(...args: unknown[]) => Promise<Response>} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {Set<string>} [options.allowed]
 * @returns {object} A Vite plugin with the route installed for dev and preview.
 */
export function upstreamRelayProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = TIMEOUT_MS,
  maxBytes = MAX_BYTES,
  allowed = ALLOWED,
  perMinute = process.env.GEV_RATELIMIT_UPSTREAM_PER_MIN,
} = {}) {
  const allow = makeCostRateLimiter(perMinute, DEFAULT_PER_MINUTE);

  function send(res, status, body, headers = {}) {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Cache-Control': 'no-store',
      ...(status === 405 ? { Allow: 'GET' } : {}),
      ...headers,
    });
    res.end(body);
  }

  function json(res, status, value) {
    send(res, status, JSON.stringify(value), {
      'Content-Type': 'application/json',
    });
  }

  async function handler(req, res) {
    if (req.method !== 'GET')
      return json(res, 405, { error: 'method_not_allowed' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(res, 404, { error: 'unknown_route' });

    const target = relayTarget(
      new URLSearchParams((req.url || '').split('?')[1] ?? '').get('url'),
      allowed,
    );
    // 403 rather than 404: an unregistered URL is refused, not absent.
    if (!target) return json(res, 403, { error: 'upstream_not_allowed' });

    if (allow && !allow(clientKey(req))) {
      return send(
        res,
        429,
        JSON.stringify({ error: 'upstream_rate_limited' }),
        {
          'Content-Type': 'application/json',
          'Retry-After': '60',
        },
      );
    }

    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(target, {
        signal,
        // An allow-listed URL must be the one fetched; a redirect would make
        // that untrue.
        redirect: 'error',
        headers: { Accept: '*/*' },
      });
    } catch (error) {
      if (error?.name === 'TimeoutError')
        return json(res, 504, { error: 'upstream_timeout' });
      return json(res, 502, { error: 'upstream_unavailable' });
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // An upstream 429 is worth passing on: the shell backs off on it.
      const status = response.status === 429 ? 429 : 502;
      return json(res, status, { error: 'upstream_unavailable' });
    }

    let bytes;
    try {
      bytes = await readResponseBytesCapped(response, maxBytes, signal);
    } catch (error) {
      if (error?.code === 'RESPONSE_TOO_LARGE')
        return json(res, 413, { error: 'upstream_too_large' });
      return json(res, 502, { error: 'upstream_unavailable' });
    }

    const type = response.headers.get('content-type');
    send(res, 200, bytes, {
      // The shell decodes protobuf, JSON and text from the same route, so the
      // upstream's own type is carried through rather than guessed.
      'Content-Type': type || 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
    });
  }

  return {
    name: 'upstream-relay',
    configureServer({ middlewares }) {
      middlewares.use('/api/upstream', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/upstream', handler);
    },
  };
}
