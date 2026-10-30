import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { readResponseTextCapped } from './common/http.js';

/**
 * Vite plugin: public TLE catalogue proxy.
 *
 * The upstream (`tle.ivanstanojevic.me`, the keyless catalogue warmonitor.app's
 * satellite layer reads) answers in 5–30 s a page — 24–30 s TTFB when measured
 * on 2026-10-30 — and is not cached. Reading it from the browser made the
 * Satellite Watch switch look broken. This route fetches one page at a time,
 * keeps it for six hours in memory and on disk, and serves the last copy marked
 * STALE-ERROR when upstream fails, exactly as the CelesTrak proxy does.
 *
 * Upstream: https://tle.ivanstanojevic.me/api/tle/?page=N
 * @returns {import('vite').Plugin}
 */
export function satelliteCatalogueProxy() {
  const TTL_MS = 6 * 3600_000;
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const mem = new Map();
  const inflight = new Map();

  const diskPath = (page) => path.join(CACHE_DIR, `tle-catalogue-${page}.json`);

  async function readDisk(page) {
    try {
      const parsed = JSON.parse(await fsp.readFile(diskPath(page), 'utf8'));
      if (typeof parsed?.body === 'string' && Number.isFinite(parsed?.at))
        return parsed;
    } catch {
      /* no cache yet */
    }
    return null;
  }

  async function writeDisk(page, entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(diskPath(page), JSON.stringify(entry), 'utf8');
    } catch {
      console.warn('[tle-catalogue] cache write failed');
    }
  }

  async function fetchUpstream(page) {
    const url = `https://tle.ivanstanojevic.me/api/tle/?page=${page}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        'User-Agent':
          'gods-eye-view-tle-catalogue/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
        Accept: 'application/json',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await readResponseTextCapped(
      response,
      MAX_RESPONSE_BYTES,
      undefined,
    );
    // An error page is not a catalogue, whatever its status said.
    if (!/"member"\s*:/.test(body))
      throw new Error('no member list in response');
    return { at: Date.now(), body };
  }

  const install = (server) => {
    server.middlewares.use('/api/tle-catalogue', async (req, res) => {
      const page = Number(
        String(req.url || '')
          .replace(/^\//, '')
          .split('?')[0],
      );
      const send = (status, body, cacheStatus) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'x-tle-cache': cacheStatus,
        });
        res.end(body);
      };
      if (!Number.isInteger(page) || page < 1 || page > 40) {
        send(400, '{"error":"invalid page"}', 'NONE');
        return;
      }
      try {
        const now = Date.now();
        let entry = mem.get(page);
        if (!entry) {
          entry = await readDisk(page);
          if (entry) mem.set(page, entry);
        }
        if (entry && now - entry.at < TTL_MS) {
          send(200, entry.body, 'HIT');
          return;
        }
        if (!inflight.has(page)) {
          inflight.set(
            page,
            fetchUpstream(page)
              .then(async (fresh) => {
                mem.set(page, fresh);
                await writeDisk(page, fresh);
                return fresh;
              })
              .catch(() => null)
              .finally(() => inflight.delete(page)),
          );
        }
        const fresh = await inflight.get(page);
        if (fresh) send(200, fresh.body, 'MISS');
        else if (entry) send(200, entry.body, 'STALE-ERROR');
        else send(502, '{"error":"catalogue unavailable"}', 'NONE');
      } catch {
        send(500, '{"error":"catalogue proxy error"}', 'ERROR');
      }
    });
  };

  return {
    name: 'tle-catalogue-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
