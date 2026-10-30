import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { celestrakTleUrl } from '../../../src/data/spaceProviderRequests.js';
import { readResponseTextCapped } from '../common/http.js';

/**
 * Vite plugin: CelesTrak TLE proxy.
 *
 * CelesTrak does not send CORS headers, so this middleware fetches
 * satellite TLE data server-side and forwards it to the browser.
 * Upstream URL: https://celestrak.org/NORAD/elements/gp.php
 *
 * @returns {import('vite').Plugin}
 */
/**
 * CelesTrak GP/TLE proxy with a memory + disk cache.
 * Upstream: https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle
 * CelesTrak asks clients not to re-fetch GP data more than ~every 2 h and
 * throttles offenders; every dev reload used to refetch every group. Cache TTL
 * 6 h; on upstream failure the freshest stale copy is served (a stale TLE
 * beats an empty satellites layer). Pattern mirrors openSkyProxy's
 * cache+serve-stale. Adapted from skylight's TleStore (MIT).
 *
 * Each refresh also keeps the body it replaced (memory and
 * `.gev-cache/celestrak-<group>-previous.json`) and serves it at
 * `GET /api/celestrak/previous/<group>`, so a first orbit-change comparison
 * has something to compare against without waiting for a second poll.
 */
export function celestrakProxy() {
  const TLE_TTL_MS = 6 * 3600_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const mem = new Map(); // group -> { at: epochMs, body: string }
  const inflight = new Map(); // group -> Promise<{at, body}|null>
  // The body the cache held before the last refresh: the element sets an
  // orbit-change comparison needs to have anything to compare on a first read.
  const previous = new Map(); // group -> { at, body, replacedAt }

  const diskPath = (group) => path.join(CACHE_DIR, `celestrak-${group}.json`);
  const previousDiskPath = (group) =>
    path.join(CACHE_DIR, `celestrak-${group}-previous.json`);

  async function readPreviousDisk(group) {
    try {
      const parsed = JSON.parse(
        await fsp.readFile(previousDiskPath(group), 'utf8'),
      );
      if (typeof parsed?.body === 'string' && Number.isFinite(parsed?.at))
        return parsed;
    } catch {
      /* no previous generation yet */
    }
    return null;
  }

  async function writePreviousDisk(group, entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(
        previousDiskPath(group),
        JSON.stringify(entry),
        'utf8',
      );
    } catch {
      console.warn('[celestrak-proxy] previous-generation write failed');
    }
  }

  async function readDisk(group) {
    try {
      const parsed = JSON.parse(await fsp.readFile(diskPath(group), 'utf8'));
      if (typeof parsed?.body === 'string' && Number.isFinite(parsed?.at))
        return parsed;
    } catch {
      /* no disk cache yet */
    }
    return null;
  }

  async function writeDisk(group, entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(diskPath(group), JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[celestrak-proxy] cache write failed');
    }
  }

  /** The largest group (`active`) measures ~2.7 MB; this bounds a runaway body. */
  const CELESTRAK_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

  async function fetchUpstream(group) {
    const url = celestrakTleUrl(group);
    const signal = AbortSignal.timeout(20000);
    const res = await fetch(url.toString(), {
      signal,
      // CelesTrak 403s bulk groups (e.g. `active`) unless the request carries a
      // descriptive User-Agent with a contact point.
      headers: {
        'User-Agent':
          'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await readResponseTextCapped(
      res,
      CELESTRAK_MAX_RESPONSE_BYTES,
      signal,
    );
    // An upstream error page parses to zero TLEs — treat as failure, keep cache.
    if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
    return { at: Date.now(), body };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/celestrak', async (req, res) => {
      const target = String(req.url || '')
        .split('?')[0]
        .replace(/\/$/, '');
      // The generation the current one replaced, for a first comparison. It is
      // a cache read only: no refresh is started for it, and a path that is not
      // exactly one group name is answered 400 rather than treated as a group.
      if (target === '/previous' || target.startsWith('/previous/')) {
        const groupName = target.slice('/previous/'.length);
        if (!/^[a-z0-9-]+$/i.test(groupName)) {
          res.writeHead(400, {
            'Content-Type': 'text/plain',
            'x-tle-cache': 'NONE',
          });
          res.end('invalid group');
          return;
        }
        try {
          let entry = previous.get(groupName);
          if (!entry) {
            entry = await readPreviousDisk(groupName);
            if (entry) previous.set(groupName, entry);
          }
          if (!entry) {
            res.writeHead(404, {
              'Content-Type': 'text/plain',
              'x-tle-cache': 'NONE',
            });
            res.end('no previous element sets');
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/plain',
            'x-tle-cache': 'PREVIOUS',
          });
          res.end(entry.body);
        } catch {
          if (res.headersSent) return;
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('celestrak proxy error');
        }
        return;
      }
      const group = target.replace(/^\//, '');
      if (!/^[a-z0-9-]+$/i.test(group)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('invalid group');
        return;
      }
      const send = (status, body, cacheStatus) => {
        // Guard against a double-send (e.g. a throw AFTER a response already
        // went out routing into the catch's send): writeHead after headersSent
        // throws "Cannot set headers after they are sent".
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'text/plain',
          'x-tle-cache': cacheStatus,
        });
        res.end(body);
      };
      try {
        const now = Date.now();
        let entry = mem.get(group);
        if (!entry) {
          entry = await readDisk(group);
          if (entry) mem.set(group, entry);
        }
        if (entry && now - entry.at < TLE_TTL_MS) {
          send(200, entry.body, 'HIT');
          return;
        }
        // Stale or missing → refresh, single-flight per group.
        if (!inflight.has(group)) {
          inflight.set(
            group,
            fetchUpstream(group)
              .then(async (fresh) => {
                // Keep what this refresh replaced: an identical body is the
                // same observation, and comparing it with itself yields no
                // change at all.
                if (entry && entry.body !== fresh.body) {
                  const replaced = {
                    at: entry.at,
                    body: entry.body,
                    replacedAt: Date.now(),
                  };
                  previous.set(group, replaced);
                  await writePreviousDisk(group, replaced);
                }
                mem.set(group, fresh);
                await writeDisk(group, fresh);
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  '[celestrak-proxy] refresh failed — serving cache if any',
                );
                return null;
              })
              .finally(() => inflight.delete(group)),
          );
        }
        const fresh = await inflight.get(group);
        if (fresh) {
          send(200, fresh.body, 'MISS');
        } else if (entry) {
          send(200, entry.body, 'STALE-ERROR'); // upstream down — stale beats empty
        } else {
          send(502, 'celestrak fetch failed and no cache available', 'NONE');
        }
      } catch (err) {
        console.error('[celestrak-proxy] request failed');
        send(500, 'celestrak proxy error', 'ERROR');
      }
    });
  };
  return {
    name: 'celestrak-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
