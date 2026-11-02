import net from 'node:net';

/**
 * Network monitoring for the operator's own, authorized nodes.
 *
 * Unlike every other provider here this one has no third-party upstream: the
 * targets are read from `GEV_NETMON_TARGETS` in this server's environment, in
 * the form
 *
 *   label|host|port|lat|lon; label|host|port|lat|lon
 *
 * A target without a position is still probed (its answer counts in the
 * summary) but cannot be drawn on the globe. Positions are declared, never
 * resolved from the host name: guessing one would render an address the
 * operator never confirmed.
 *
 * The browser never talks to a target itself — this server does, so the
 * request the operator authorizes is the probing one and the dashboard merely
 * shows the result. Probing is plain TCP connect on an injected deadline:
 * no payload is sent, so the probe cannot do more than confirm that a port
 * accepts a connection.
 */

const TIMEOUT_MS = 5000;
const CACHE_MS = 30_000;
const STALE_MAX_MS = 10 * 60_000;
const MAX_TARGETS = 64;
const USER_AGENT_NOTE = 'tcp connect probe, no payload';

/**
 * Parse the configured targets. A malformed entry is skipped, not fatal: one
 * typo in an env var must not take the whole layer down.
 *
 * @param {string} raw the `GEV_NETMON_TARGETS` value
 * @returns {{id:string,label:string,host:string,port:number,lat:number|null,lon:number|null}[]}
 */
export function parseNetmonTargets(raw) {
  return String(raw || '')
    .split(';')
    .flatMap((entry, index) => {
      const parts = entry.split('|').map((part) => part.trim());
      const [label, host, port, lat, lon] = parts;
      if (!label || !host || !/^\d{1,5}$/.test(port)) return [];
      const portNumber = Number(port);
      if (portNumber < 1 || portNumber > 65535) return [];
      const parsedLat = Number(lat);
      const parsedLon = Number(lon);
      const validLat =
        lat !== '' &&
        Number.isFinite(parsedLat) &&
        parsedLat >= -90 &&
        parsedLat <= 90;
      const validLon =
        lon !== '' &&
        Number.isFinite(parsedLon) &&
        parsedLon >= -180 &&
        parsedLon <= 180;
      return [
        {
          // The id is the endpoint itself, not a list position: it stays stable
          // as entries are added or removed, and two configured entries for the
          // same endpoint collapse onto one marker.
          id: `netmon:${host}:${port}`,
          label,
          host,
          port: portNumber,
          lat: validLat && validLon ? parsedLat : null,
          lon: validLat && validLon ? parsedLon : null,
        },
      ];
    })
    .slice(0, MAX_TARGETS);
}

/**
 * One TCP connect probe. Resolves with the answer rather than rejecting: a
 * closed port is data about the node, not a failure of this module.
 *
 * @param {string} host
 * @param {number} port
 * @param {{timeoutMs?: number}} [options]
 */
export function tcpProbe(host, port, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok, error = null) => {
      if (settled) return;
      settled = true;
      // The result must not depend on a socket teardown racing the answer.
      socket.removeAllListeners('connect');
      socket.destroy();
      resolve({ ok, latencyMs: Date.now() - startedAt, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (err) =>
      finish(false, err?.code || err?.message || 'error'),
    );
  });
}

/** One configured target became a row, or it has no position and is skipped. */
export function mapTargetRow(target, result) {
  if (!target?.lat || !target?.lon) return null;
  // A probe takes place when it ran; absent means probed before this round.
  const checkedAt = result?.checkedAt ?? null;
  return {
    id: target.id,
    lat: target.lat,
    lon: target.lon,
    label: target.label,
    meta: {
      status:
        result?.ok === true ? 'up' : result?.ok === false ? 'down' : 'unknown',
      latencyMs: Number.isFinite(result?.latencyMs) ? result.latencyMs : null,
      error: result?.error ?? null,
      host: `${target.host}:${target.port}`,
      checkedAt,
    },
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.env] raw GEV_NETMON_TARGETS value
 * @param {Function} [options.probe] async (host, port) => {ok, latencyMs, error}
 * @param {Function} [options.now] clock
 */
export function netMonProxy({
  env = process.env.GEV_NETMON_TARGETS,
  probe = tcpProbe,
  now = () => Date.now(),
} = {}) {
  const targets = parseNetmonTargets(env);
  let cache = null; // { savedAt, rows, upstreamCount }
  let refreshing = null;
  // Only positioned targets can be drawn; the rest are probed anyway and the
  // gap between the two counts is the operator's hint to add lat/lon.
  const placedTargetsId = new Set(
    targets
      .filter((target) => target.lat != null && target.lon != null)
      .map((target) => target.id),
  );

  /**
   * Probe every target once. All probes run concurrently under their own
   * deadlines; the worst call is bounded by the probe timeout, not by the
   * number of targets.
   */
  async function probeAll(signal) {
    if (!targets.length) return [];
    const results = await Promise.all(
      targets.map(async (target) => ({
        target,
        result: {
          ...(await probe(target.host, target.port)),
          checkedAt: now(),
        },
      })),
    );
    signal?.throwIfAborted();
    return results
      .map(({ target, result }) => mapTargetRow(target, result))
      .filter(Boolean);
  }

  /**
   * Refresh the cache. One in-flight refresh at a time: several browser
   * polls must not become several probe rounds per interval.
   */
  function refresh(signal) {
    if (refreshing) return refreshing;
    refreshing = probeAll(signal)
      .then((rows) => {
        cache = { savedAt: now(), rows, upstreamCount: rows.length };
        return Boolean(targets.length && rows.length);
      })
      .catch(() => {
        // A failed round keeps the last good answer, which is exactly why a
        // map of node states must not go blank while its own network is down.
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  async function read(signal) {
    const fresh = cache && now() - cache.savedAt < CACHE_MS;
    if (!cache) {
      // First caller waits for the answer; later polls are served instantly.
      await refresh(signal);
      return { ...cache, ageMs: now() - cache.savedAt, stale: false };
    }
    if (!fresh) void refresh();
    const ageMs = now() - cache.savedAt;
    return { ...cache, ageMs, stale: ageMs > STALE_MAX_MS };
  }

  function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 || status === 502 ? { 'Retry-After': '60' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    if ((url.pathname || '/') !== '/')
      return json(404, { error: 'unknown_route' });
    if (!targets.length) {
      // Nothing was configured, so retrying cannot fix it: the row explains
      // the next step instead, the same contract the radio-sites route uses.
      return json(503, { error: 'netmon_not_configured' });
    }
    const signal = new AbortController().signal;
    read(signal).then(
      ({ rows, ageMs, stale }) =>
        json(200, {
          points: rows,
          ageMs,
          stale,
          truncated: false,
          configured: true,
          totalTargets: targets.length,
          placedTargets: placedTargetsId.size,
          attribution: {
            label: 'Operator nodes',
            licence: 'probed by this server',
            method: USER_AGENT_NOTE,
          },
        }),
      (error) =>
        json(502, {
          error: 'netmon_unavailable',
          reason:
            error?.name === 'AbortError' ? 'timeout' : (error?.message ?? null),
        }),
    );
  }

  return {
    name: 'netmon',
    // Exposed for the route's own tests; the plugin contract is the two
    // configure*Server hooks.
    handler,
    configureServer({ middlewares }) {
      middlewares.use('/api/netmon', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/netmon', handler);
    },
  };
}
