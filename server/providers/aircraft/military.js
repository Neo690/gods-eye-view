import { readResponseTextCapped } from '../common/http.js';
import {
  configuredMilitaryFeeds,
  mergeMilitaryPayloads,
  militaryFeedHeaders,
} from './military-feeds.js';

/**
 * Vite plugin: military aircraft proxy over several community feeds.
 *
 * Serves GET /api/military by reading every configured feed (see
 * `military-feeds.js`) and merging the answers by ICAO24. Each feed owns its
 * 12 s response cache AND its own cooldown, so one feed rate-limiting itself —
 * or disappearing entirely — never costs the others' data: the merge serves
 * whatever answered, in one readsb-shaped body, and names the feeds it used in
 * `X-Feed-Source` with their per-feed counts in `X-Military-Sources`.
 *
 * When a feed fails, its cached body is served as STALE instead of relaying the
 * failure, and that feed's upstream is left alone for its Retry-After period
 * (bounded) so a rate limit is never hammered mid-cooldown. With nothing cached
 * anywhere, the failure is relayed as-is: the browser layer treats a relayed 429
 * as a 45 s cooldown during which EVERY refresh (the 15 s poll and any tracking
 * resolve) reports "rate limited" while the map is still fully populated, so a
 * real 429 must still reach it rather than being swallowed.
 *
 * @param {{feeds?: Array<object>}} [options] Feeds to read. Defaults to the
 *   keyless ones plus any keyed feed whose variable the operator set, and is
 *   injectable so a test can exercise a single feed's cache and cooldown.
 * @returns {import('vite').Plugin}
 */
export function militaryProxy({ feeds = configuredMilitaryFeeds() } = {}) {
  /** Response cache TTL (ms), per feed. */
  const CACHE_MS = 12000;
  /** Upstream deadline (ms); the fetch previously had none and could hang a poll. */
  const UPSTREAM_TIMEOUT_MS = 12000;
  /** /v2/mil measures ~67 KB; a relayed error page is bounded by the same cap. */
  const MILITARY_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
  /** Cooldown after a 429 when upstream sends no usable Retry-After (ms). */
  const RATE_LIMIT_COOLDOWN_MS = 30000;
  /** Cooldown after a 5xx (ms). */
  const SERVER_ERROR_COOLDOWN_MS = 15000;
  /** Bounds for an upstream-supplied Retry-After (ms). */
  const COOLDOWN_MIN_MS = 5000;
  const COOLDOWN_MAX_MS = 120000;

  const clampCooldown = (ms) =>
    Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));

  /** Cooldown (ms) an upstream failure earns, honouring Retry-After when sane. */
  function cooldownFor(upstream, now) {
    const raw = upstream.headers?.get?.('retry-after');
    if (raw) {
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds > 0)
        return clampCooldown(seconds * 1000);
      const at = Date.parse(raw);
      if (Number.isFinite(at) && at > now) return clampCooldown(at - now);
    }
    return upstream.status === 429
      ? RATE_LIMIT_COOLDOWN_MS
      : SERVER_ERROR_COOLDOWN_MS;
  }

  /** One feed's cache, cooldown and last-failure status. */
  const states = feeds.map((feed) => ({
    feed,
    body: null,
    cacheAt: 0,
    cooldownUntil: 0,
    cooldownStatus: 0,
  }));

  /** Serve one feed's cached body, which the merge still counts as an answer. */
  const stale = (state, now) => ({
    id: state.feed.id,
    body: state.body,
    cache: 'STALE',
    ageMs: now - state.cacheAt,
    upstreamStatus: state.cooldownStatus,
    retryAfterSeconds: Math.ceil(Math.max(0, state.cooldownUntil - now) / 1000),
  });

  /**
   * One feed's contribution to this request.
   *
   * Never throws: a feed that fails resolves to a `failure` the caller can
   * ignore as long as another feed answered.
   */
  async function refresh(state) {
    const now = Date.now();
    if (state.body && now - state.cacheAt < CACHE_MS)
      return {
        id: state.feed.id,
        body: state.body,
        cache: 'HIT',
        ageMs: now - state.cacheAt,
      };
    if (now < state.cooldownUntil) {
      const retryAfterSeconds = Math.ceil(
        (state.cooldownUntil - Date.now()) / 1000,
      );
      if (state.body) return { ...stale(state, now), retryAfterSeconds };
      return {
        id: state.feed.id,
        failure: {
          cooling: true,
          status: state.cooldownStatus || 503,
          retryAfterSeconds,
        },
      };
    }
    const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(state.feed.url, {
        headers: militaryFeedHeaders(state.feed),
        signal,
      });
    } catch (e) {
      console.error(`[Military Proxy] ${state.feed.id}: ${e.message}`);
      if (state.body) return stale(state, now);
      return { id: state.feed.id, failure: { status: 502 } };
    }
    if (upstream.ok) {
      try {
        const body = await readResponseTextCapped(
          upstream,
          MILITARY_MAX_RESPONSE_BYTES,
          signal,
        );
        state.body = body;
        state.cacheAt = Date.now();
        state.cooldownUntil = 0;
        state.cooldownStatus = 0;
        return { id: state.feed.id, body, cache: 'MISS', ageMs: 0 };
      } catch (e) {
        // An unreadable body is not an answer: keep it out of the cache so the
        // next refresh retries instead of serving a truncated snapshot.
        console.error(`[Military Proxy] ${state.feed.id}: ${e.message}`);
        if (state.body) return stale(state, now);
        return { id: state.feed.id, failure: { status: 502 } };
      }
    }
    if (upstream.status === 429 || upstream.status >= 500) {
      const failedAt = Date.now();
      state.cooldownUntil = failedAt + cooldownFor(upstream, failedAt);
      state.cooldownStatus = upstream.status;
      console.warn(
        `[Military Proxy] ${state.feed.id} upstream ${upstream.status}; cooling down ${Math.round((state.cooldownUntil - Date.now()) / 1000)} s${state.body ? ', serving stale' : ''}`,
      );
      if (state.body) {
        // Do not wait for a failing response body before serving usable data.
        upstream.body?.cancel().catch(() => {});
        return stale(state, failedAt);
      }
      return {
        id: state.feed.id,
        failure: {
          status: upstream.status,
          retryAfterSeconds: Math.ceil(
            (state.cooldownUntil - Date.now()) / 1000,
          ),
        },
      };
    }
    // Any other status describes the request, not the load (a 400 for a
    // malformed upstream query, a 403 for a feed that wants a key): relay it
    // verbatim, since a cooldown would only hide what upstream is saying.
    // It is also logged, because a keyed feed rejected for its key is otherwise
    // invisible: the answer simply arrives without that feed. The key itself is
    // never logged.
    console.warn(
      `[Military Proxy] ${state.feed.id} upstream ${upstream.status}; answering without it`,
    );
    const body = await readResponseTextCapped(
      upstream,
      MILITARY_MAX_RESPONSE_BYTES,
      signal,
    );
    return { id: state.feed.id, failure: { status: upstream.status, body } };
  }

  function serve(res, status, body, cacheStatus, extra = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Feed-Cache': cacheStatus,
      ...extra,
    });
    res.end(body);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/military', async (req, res, next) => {
      try {
        // This mount also matches its /track route, served by its own handler.
        if (new URL(req.url || '/', 'http://localhost').pathname !== '/')
          return next();

        const answers = await Promise.all(states.map(refresh));
        const contributing = answers.filter(
          (answer) => answer.body !== undefined,
        );

        if (contributing.length) {
          const merged = mergeMilitaryPayloads(
            contributing.map(({ id, body }) => ({ id, body })),
          );
          // The oldest contributing snapshot dates the merged one: claiming the
          // freshest would let one fast feed make another's stale rows look new.
          const ageMs = Math.max(...contributing.map((answer) => answer.ageMs));
          const failures = answers.filter((answer) => answer.failure);
          const isStale = contributing.some(
            (answer) => answer.cache === 'STALE',
          );
          const cacheStatus = isStale
            ? 'STALE'
            : contributing.some((answer) => answer.cache === 'MISS')
              ? 'MISS'
              : 'HIT';
          // A contribution served stale carries the upstream status and the
          // cooldown that made it stale: that is what the layer's status row
          // explains, and it is the only place a throttled feed stays visible
          // while the other feeds keep the answer populated.
          const degraded = contributing.filter(
            (answer) => answer.upstreamStatus !== undefined,
          );
          const retryAfterSeconds = Math.max(
            0,
            ...degraded.map((answer) => answer.retryAfterSeconds || 0),
            ...failures.map((answer) => answer.failure.retryAfterSeconds || 0),
          );
          serve(res, 200, merged.body, cacheStatus, {
            'X-Feed-Source': contributing.map((answer) => answer.id).join('+'),
            'X-Military-Sources': merged.sources
              .map((source) => `${source.id}=${source.count}`)
              .join(','),
            ...(['HIT', 'STALE'].includes(cacheStatus)
              ? { 'X-Feed-Age-Ms': String(ageMs) }
              : {}),
            ...(degraded.length
              ? {
                  'X-ADS-B-Upstream-Status': String(degraded[0].upstreamStatus),
                  'X-ADS-B-Retry-After-Seconds': String(retryAfterSeconds),
                }
              : {}),
          });
          return;
        }

        // Nothing answered at all: relay the failure, which is what keeps the
        // browser's own cooldown honest.
        const failures = answers
          .map((answer) => answer.failure)
          .filter(Boolean);
        const first = failures[0] || { status: 502 };
        const retryAfterSeconds = Math.max(
          0,
          ...failures.map((failure) => failure.retryAfterSeconds || 0),
        );
        const cooling = failures.length > 0 && failures.every((f) => f.cooling);
        serve(
          res,
          first.status,
          cooling
            ? JSON.stringify({ error: 'military upstreams cooling down' })
            : first.body || JSON.stringify({ error: 'ADS-B proxy error' }),
          cooling ? 'NONE' : 'MISS',
          {
            'X-Feed-Source': states.map((state) => state.feed.id).join('+'),
            ...(retryAfterSeconds > 0
              ? { 'Retry-After': String(retryAfterSeconds) }
              : {}),
          },
        );
      } catch (e) {
        console.error('[Military Proxy]', e.message);
        serve(
          res,
          502,
          JSON.stringify({ error: 'ADS-B proxy error' }),
          'MISS',
          { 'X-Feed-Source': states.map((state) => state.feed.id).join('+') },
        );
      }
    });
  };
  return {
    name: 'military-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
