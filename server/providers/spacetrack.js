import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from './common/http.js';

/**
 * Vite plugin: Space-Track GP (official element sets) and public CDM
 * (conjunction data messages) proxy.
 *
 * Space-Track is account-gated and throttled on purpose: its usage guidelines
 * allow fewer than 30 queries a minute, **one GP query an hour** and **three
 * CDM downloads a day** (one per eight hours) for the whole public conjunction
 * feed. An account can be suspended for ignoring them, so this route is the
 * only place that logs in, caches far longer than the layer polls, and answers
 * its last copy through an outage instead of asking again.
 *
 * Routes:
 *   GET /api/spacetrack/gp  → { fetchedAt, stale, entries: [{norad,name,line1,line2}] }
 *   GET /api/spacetrack/cdm → { fetchedAt, stale, messages: [...] }
 *
 * Credentials come from `SPACETRACK_USER` / `SPACETRACK_PASSWORD` and never
 * reach the browser. Missing credentials answer `503 {"error":"no_key"}` so a
 * switch can say the account is missing rather than show an empty sky.
 *
 * Upstream: https://www.space-track.org/ajaxauth/login + /basicspacedata/query/
 * @returns {import('vite').Plugin}
 */
export function spaceTrackProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  credentials = () => ({
    identity: String(process.env.SPACETRACK_USER || '').trim(),
    password: String(process.env.SPACETRACK_PASSWORD || '').trim(),
  }),
  gpCacheMs = 60 * 60_000,
  cdmCacheMs = 8 * 60 * 60_000,
  staleMaxMs = 24 * 60 * 60_000,
  timeoutMs = 40_000,
  limit = 1200,
} = {}) {
  const LOGIN_URL = 'https://www.space-track.org/ajaxauth/login';
  const QUERY_BASE = 'https://www.space-track.org/basicspacedata/query/class/';
  const MAX_BYTES = 12 * 1024 * 1024;
  const SESSION_TTL_MS = 6 * 60 * 60_000;
  const USER_AGENT = 'gods-eye-view-spacetrack/1.0 (+satellite layers)';

  /** Cookies are the whole session; there is no token to refresh. */
  let session = { cookie: '', at: 0 };
  const cache = new Map();
  const inflight = new Map();

  const missingCredentials = () => {
    const { identity, password } = credentials();
    return !identity || !password;
  };

  async function login() {
    const { identity, password } = credentials();
    const body = new URLSearchParams({ identity, password }).toString();
    const response = await fetchImpl(LOGIN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/plain, */*',
        'User-Agent': USER_AGENT,
      },
      body,
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`login HTTP ${response.status}`);
    }
    const cookies = (response.headers.getSetCookie?.() || [])
      .map((line) => String(line).split(';')[0])
      .filter((pair) => pair.includes('='));
    await response.body?.cancel?.().catch(() => {});
    if (!cookies.length) throw new Error('login returned no session');
    session = { cookie: cookies.join('; '), at: now() };
    return session.cookie;
  }

  /** One authenticated read, re-logging once when a session has expired. */
  async function read(queryPath, { json = true } = {}) {
    const attempt = async () => {
      if (!session.cookie || now() - session.at > SESSION_TTL_MS) await login();
      const response = await fetchImpl(`${QUERY_BASE}${queryPath}`, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
        headers: {
          Accept: json ? 'application/json' : 'text/plain',
          Cookie: session.cookie,
          'User-Agent': USER_AGENT,
        },
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel?.().catch(() => {});
        session = { cookie: '', at: 0 };
        return { retry: true };
      }
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = json
        ? await readResponseJsonCapped(response, MAX_BYTES, undefined)
        : await readResponseTextCapped(response, MAX_BYTES, undefined);
      // Space-Track answers an expired session with the login page and a 200.
      if (typeof payload === 'string' && /Please login/i.test(payload)) {
        session = { cookie: '', at: 0 };
        return { retry: true };
      }
      return { payload };
    };
    const first = await attempt();
    if (!first.retry) return first.payload;
    const second = await attempt();
    if (second.retry) throw new Error('session refused');
    return second.payload;
  }

  /** The newest element set per on-orbit object, in TLE text, parsed upstream. */
  async function gp() {
    const text = await read(
      // `epoch > now-10` keeps only propagable ephemerides, as the guidelines
      // ask; `<100000` keeps the legacy two-line format readable (objects above
      // that range exist only in the extensible formats).
      `gp/decay_date/null-val/epoch/%3Enow-10/NORAD_CAT_ID/%3C100000/orderby/norad_cat_id/limit/${limit}/format/tle`,
      { json: false },
    );
    const entries = [];
    let current = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('1 ')) current = { ...(current || {}), line1: line };
      else if (line.startsWith('2 ') && current) {
        current.line2 = line;
        const norad = line.slice(2, 7).trim();
        if (norad) entries.push({ ...current, norad });
        current = null;
      } else current = { ...(current || {}), name: line };
    }
    return entries;
  }

  /** The public conjunction feed, newest last close approach first. */
  async function cdm() {
    const rows = await read(
      'cdm_public/orderby/TCA%20desc/limit/60/format/json',
    );
    return Array.isArray(rows) ? rows : [];
  }

  const serve = (kind) => async (req, res) => {
    const json = (status, value, headers = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...headers,
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET')
      return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    if (missingCredentials())
      return json(503, { error: 'no_key' }, { 'Retry-After': '600' });

    const path = String(req.url || '/');
    if (path !== '/' && !path.startsWith('/?'))
      return json(404, { error: 'unknown_route' });

    const ttl = kind === 'gp' ? gpCacheMs : cdmCacheMs;
    const clock = now();
    try {
      let entry = cache.get(kind);
      if (entry && clock - entry.at < ttl)
        return json(
          200,
          { ...entry.value, stale: false },
          {
            'x-spacetrack-cache': 'HIT',
          },
        );
      if (!inflight.has(kind)) {
        inflight.set(
          kind,
          (kind === 'gp' ? gp() : cdm())
            .then((payload) => {
              const value =
                kind === 'gp'
                  ? { fetchedAt: clock, entries: payload }
                  : { fetchedAt: clock, messages: payload };
              cache.set(kind, { at: clock, value });
              return value;
            })
            .finally(() => inflight.delete(kind)),
        );
      }
      let fresh = null;
      try {
        fresh = await inflight.get(kind);
      } catch (error) {
        const stale = cache.get(kind);
        if (stale && clock - stale.at <= staleMaxMs)
          return json(
            200,
            { ...stale.value, stale: true },
            {
              'x-spacetrack-cache': 'STALE-ERROR',
            },
          );
        throw error;
      }
      return json(
        200,
        { ...fresh, stale: false },
        {
          'x-spacetrack-cache': 'MISS',
        },
      );
    } catch (error) {
      console.warn(`[spacetrack] ${kind} failed:`, error?.message || error);
      return json(
        502,
        { error: 'spacetrack_unavailable' },
        { 'Retry-After': '900' },
      );
    }
  };

  const install = (server) => {
    server.middlewares.use('/api/spacetrack/gp', serve('gp'));
    server.middlewares.use('/api/spacetrack/cdm', serve('cdm'));
  };

  return {
    name: 'spacetrack-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
