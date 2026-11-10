import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GHOSTMAPS_MAX_FILE_BYTES,
  GHOSTMAPS_REPO,
  buildGhostMapsCatalog,
  ghostMapsRawUrl,
  parseGitRefAdvertisement,
} from '../../src/layers/ghostMaps/catalog.js';
import {
  readResponseBytesCapped,
  readResponseJsonCapped,
  readResponseTextCapped,
} from './common/http.js';

// S2 Underground GhostMaps (public GitHub repository of KMZ intel products).
// The repository is not ours, so there is no webhook: the watcher reads the
// branch head through git's smart-HTTP ref advertisement (~0.5 KB, outside the
// REST API rate limit) every few seconds, and only a new commit costs REST
// calls (tree + commit). Browsers hear about a new commit over server-sent
// events and fetch only the products whose blob changed. Files are fetched by
// commit-pinned raw URLs and kept on disk by blob sha.

const DEFAULT_POLL_MS = 15_000;
const MIN_POLL_MS = 5_000;
const FAILURE_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
const TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 120_000;
const HEARTBEAT_MS = 25_000;
const MAX_SUBSCRIBERS = 64;
const MAX_REF_BYTES = 64 * 1024;
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const MAX_COMMIT_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const HTML_TIMEOUT_MS = 20_000;
const MAX_HTML_TREE_PAGES = 64;
const USER_AGENT = 'gods-eye-view-ghostmaps/1.0';
const REPO_PATH = `${GHOSTMAPS_REPO.owner}/${GHOSTMAPS_REPO.name}`;

// Directories that cannot hold a curated product. The HTML fallback walks
// GitHub's tree pages, so skipping archives keeps a rate-limited check cheap.
const HTML_TREE_SKIP =
  /(^|\/)(?:\.github|0_archive|archive|basedata|reference material)(?:\/|$)|^Global Centers of Gravity(?:\/|$)/i;

/** Poll interval from GHOSTMAPS_POLL_SECONDS, bounded below at 5 s. */
export function ghostMapsPollMs(raw = process.env.GHOSTMAPS_POLL_SECONDS) {
  const seconds = Number(raw);
  if (!raw || !Number.isFinite(seconds)) return DEFAULT_POLL_MS;
  return Math.max(MIN_POLL_MS, Math.round(seconds * 1000));
}

/**
 * Read the file list GitHub embeds in a rendered tree page.
 * @param {string} html
 * @param {string} [sha] Expected commit; a page for another commit is refused.
 * @returns {{items: Array<{name: string, path: string, contentType: string}>}}
 */
export function parseGhostMapsTreePage(html, sha) {
  const match =
    /<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/.exec(
      String(html || ''),
    );
  if (!match) throw new Error('GhostMaps tree page malformed');
  let payload;
  try {
    payload = JSON.parse(match[1])?.payload?.codeViewTreeRoute;
  } catch {
    throw new Error('GhostMaps tree page malformed');
  }
  const currentOid = payload?.refInfo?.currentOid ?? payload?.currentOid;
  if (sha && currentOid !== sha) throw new Error('GhostMaps tree page moved');
  const items = payload?.tree?.items;
  if (!Array.isArray(items)) throw new Error('GhostMaps tree page malformed');
  return {
    items: items.filter(
      (item) =>
        item &&
        typeof item.path === 'string' &&
        (item.contentType === 'file' || item.contentType === 'directory'),
    ),
  };
}

/**
 * The repository watcher and file cache, independent of HTTP routing.
 * @returns {{start: Function, stop: Function, catalog: Function,
 *   checkNow: Function, file: Function, subscribe: Function}}
 */
export function createGhostMapsWatcher({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  pollMs = ghostMapsPollMs(),
  cacheDir = path.join(process.cwd(), '.gev-cache', 'ghostmaps'),
  token = () => String(process.env.GITHUB_TOKEN || '').trim(),
  log = (...args) => console.log(...args),
  warn = (...args) => console.warn(...args),
} = {}) {
  let state = {
    commit: null,
    committedAt: null,
    message: null,
    products: [],
    checkedAt: null,
    changedAt: null,
    error: null,
  };
  let timer = null;
  let running = false;
  let checking = null;
  let failures = 0;
  let diskLoaded = false;
  const listeners = new Set();
  const downloads = new Map();
  // A packaged desktop app keeps its payload under Program Files, where the
  // default cache beside the app is not writable. The cache is only an
  // optimization: fall back to the user's temp directory, and if that also
  // fails, still serve the bytes that were just downloaded.
  const fallbackCacheDir = path.join(os.tmpdir(), 'gods-eye-view', 'ghostmaps');
  const unwritableCache = new Set(['EPERM', 'EACCES', 'EROFS']);
  let cacheRoot = cacheDir;

  /** Run one cache write, retrying once in a writable root on permission fails. */
  async function writeCache(write) {
    try {
      await write();
      return true;
    } catch (error) {
      if (unwritableCache.has(error?.code) && cacheRoot !== fallbackCacheDir) {
        cacheRoot = fallbackCacheDir;
        try {
          await write();
          return true;
        } catch (retry) {
          error = retry;
        }
      }
      warn('[ghostmaps] could not cache:', error.message);
      return false;
    }
  }

  const apiHeaders = (useToken = true) => ({
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    ...(useToken && token() ? { Authorization: `Bearer ${token()}` } : {}),
  });

  function contentVersion(seed) {
    return createHash('sha1').update(seed).digest('hex');
  }

  /** Read one GitHub tree page's embedded file list, pinned to `sha`. */
  async function readHtmlTreePage(sha, dirPath) {
    const encoded = dirPath
      ? `/${dirPath.split('/').map(encodeURIComponent).join('/')}`
      : '';
    const response = await get(
      `https://github.com/${REPO_PATH}/tree/${sha}${encoded}`,
      { 'User-Agent': USER_AGENT },
      HTML_TIMEOUT_MS,
    );
    const html = await readResponseTextCapped(response, MAX_HTML_BYTES);
    return parseGhostMapsTreePage(html, sha);
  }

  /**
   * The full KMZ path list from GitHub's rendered tree pages. This is the
   * anonymous fallback for a datacenter IP that GitHub's REST API rate-limits;
   * the pages are pinned to the commit so a moving branch cannot mix editions.
   */
  async function readHtmlTree(sha) {
    const queue = [''];
    const seen = new Set();
    const entries = [];
    while (queue.length && seen.size < MAX_HTML_TREE_PAGES) {
      const dir = queue.shift();
      if (seen.has(dir) || HTML_TREE_SKIP.test(`${dir}/`)) continue;
      seen.add(dir);
      const page = await readHtmlTreePage(sha, dir);
      for (const item of page.items) {
        if (item?.contentType === 'directory') {
          if (!HTML_TREE_SKIP.test(`${item.path}/`)) queue.push(item.path);
        } else if (
          item?.contentType === 'file' &&
          typeof item.path === 'string' &&
          /\.kmz$/i.test(item.path)
        ) {
          // Size and version are filled from each selected file's HEAD below.
          entries.push({
            path: item.path,
            type: 'blob',
            sha: contentVersion(`path:${item.path}`),
            size: 1,
          });
        }
      }
    }
    if (queue.length)
      warn('[ghostmaps] HTML tree walk reached its page budget');
    return entries;
  }

  async function readHtmlCommit(sha) {
    const rows = buildGhostMapsCatalog(await readHtmlTree(sha));
    const products = [];
    for (const row of rows) {
      try {
        const response = await fetchImpl(ghostMapsRawUrl(sha, row.path), {
          method: 'HEAD',
          headers: { 'User-Agent': USER_AGENT },
          redirect: 'follow',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const size = Number(response.headers.get('content-length'));
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw Object.assign(new Error(`HTTP ${response.status}`), {
            status: response.status,
          });
        }
        if (
          !Number.isFinite(size) ||
          size <= 0 ||
          size > GHOSTMAPS_MAX_FILE_BYTES
        )
          continue;
        products.push({
          ...row,
          size,
          version: contentVersion(
            response.headers.get('etag') || `${sha}:${row.path}`,
          ),
        });
      } catch (error) {
        warn(`[ghostmaps] could not size ${row.fileName}: ${error.message}`);
      }
    }
    return { products, committedAt: null, message: null };
  }

  /**
   * GitHub answers 401/403 for a stale or under-scoped token. The repository
   * is public, so retry once without the credential before failing the check;
   * a rate-limited anonymous request still reports its own HTTP 403.
   */
  async function readApi(url, maxBytes) {
    try {
      return await readResponseJsonCapped(
        await get(url, apiHeaders()),
        maxBytes,
      );
    } catch (error) {
      if (!token() || (error.status !== 401 && error.status !== 403))
        throw error;
      warn(
        `[ghostmaps] authenticated read failed (HTTP ${error.status}); retrying anonymously`,
      );
      return readResponseJsonCapped(
        await get(url, apiHeaders(false)),
        maxBytes,
      );
    }
  }

  async function get(url, headers, timeoutMs = TIMEOUT_MS) {
    const response = await fetchImpl(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`HTTP ${response.status} from ${url}`), {
        status: response.status,
      });
    }
    return response;
  }

  async function readHead() {
    const response = await get(
      `${GHOSTMAPS_REPO.url}.git/info/refs?service=git-upload-pack`,
      { 'User-Agent': USER_AGENT },
    );
    const sha = parseGitRefAdvertisement(
      await readResponseTextCapped(response, MAX_REF_BYTES),
    );
    if (!sha) throw new Error('GhostMaps branch head not advertised');
    return sha;
  }

  async function readApiCommit(sha) {
    const api = `https://api.github.com/repos/${REPO_PATH}`;
    const tree = await readApi(
      `${api}/git/trees/${sha}?recursive=1`,
      MAX_TREE_BYTES,
    );
    if (!Array.isArray(tree?.tree)) throw new Error('GhostMaps tree malformed');
    if (tree.truncated) warn('[ghostmaps] repository tree listing truncated');
    let committedAt = null;
    let message = null;
    try {
      const commit = await readApi(`${api}/commits/${sha}`, MAX_COMMIT_BYTES);
      committedAt = Date.parse(commit?.commit?.committer?.date) || null;
      message = String(commit?.commit?.message || '')
        .split('\n')[0]
        .slice(0, 200);
    } catch {
      // The commit date is decoration; the tree is what matters.
    }
    return { products: buildGhostMapsCatalog(tree.tree), committedAt, message };
  }

  async function readCommit(sha) {
    try {
      return await readApiCommit(sha);
    } catch (apiError) {
      warn(
        `[ghostmaps] GitHub API read failed (${apiError.message}); using the HTML tree`,
      );
      try {
        return await readHtmlCommit(sha);
      } catch (htmlError) {
        throw new Error(
          `${apiError.message}; HTML fallback: ${htmlError.message}`,
        );
      }
    }
  }

  async function loadDisk() {
    if (diskLoaded) return;
    diskLoaded = true;
    try {
      const saved = JSON.parse(
        await fsp.readFile(path.join(cacheRoot, 'catalog.json'), 'utf8'),
      );
      if (/^[0-9a-f]{40}$/.test(saved?.commit) && Array.isArray(saved.products))
        state = { ...state, ...saved, error: null };
    } catch {
      /* first run */
    }
  }

  async function saveDisk() {
    await writeCache(async () => {
      await fsp.mkdir(cacheRoot, { recursive: true });
      const { commit, committedAt, message, products, changedAt } = state;
      await fsp.writeFile(
        path.join(cacheRoot, 'catalog.json'),
        JSON.stringify({ commit, committedAt, message, products, changedAt }),
      );
    });
  }

  function emit() {
    const event = publicCatalog();
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        /* a broken subscriber must not stop the rest */
      }
    }
  }

  async function check() {
    await loadDisk();
    const head = await readHead();
    state.checkedAt = now();
    if (head === state.commit) {
      if (state.error !== null) {
        state.error = null;
        emit();
      }
      return false;
    }
    const next = await readCommit(head);
    const previous = new Map(state.products.map((p) => [p.id, p.version]));
    const changed = next.products
      .filter((p) => previous.get(p.id) !== p.version)
      .map((p) => p.id);
    state = {
      ...state,
      ...next,
      commit: head,
      changedAt: now(),
      error: null,
    };
    log(
      `[ghostmaps] commit ${head.slice(0, 8)}${
        next.message ? ` "${next.message}"` : ''
      }; updated: ${changed.join(', ') || 'none'}`,
    );
    await saveDisk();
    emit();
    // Warm the default products so the first browser load is local.
    for (const product of state.products)
      if (product.defaultOn) file(product.id).catch(() => {});
    return true;
  }

  /** Run one check now, coalescing with one already in flight. */
  function checkNow() {
    if (!checking)
      checking = check()
        .then(
          (changed) => {
            failures = 0;
            return changed;
          },
          (error) => {
            failures += 1;
            state.error = error.message;
            state.checkedAt = now();
            warn('[ghostmaps] check failed:', error.message);
            emit();
            return false;
          },
        )
        .finally(() => {
          checking = null;
        });
    return checking;
  }

  function schedule() {
    clearTimeout(timer);
    if (!running) return;
    const delay = failures
      ? FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length) - 1]
      : pollMs;
    timer = setTimeout(async () => {
      await checkNow();
      schedule();
    }, delay);
    timer.unref?.();
  }

  /** Start watching (idempotent); the first check runs immediately. */
  function start() {
    if (running) return checking || Promise.resolve(false);
    running = true;
    const first = checkNow();
    first.then(schedule);
    return first;
  }

  function stop() {
    running = false;
    clearTimeout(timer);
    timer = null;
  }

  function publicCatalog() {
    return {
      repo: GHOSTMAPS_REPO.url,
      branch: GHOSTMAPS_REPO.branch,
      commit: state.commit,
      committedAt: state.committedAt,
      message: state.message,
      checkedAt: state.checkedAt,
      changedAt: state.changedAt,
      pollMs,
      error: state.error,
      products: state.products.map(
        ({
          id,
          title,
          defaultOn,
          fileName,
          fileTitle,
          version,
          size,
          dateMs,
        }) => ({
          id,
          title,
          defaultOn,
          fileName,
          fileTitle,
          version,
          size,
          dateMs,
        }),
      ),
    };
  }

  /**
   * The bytes of one product's current edition, from disk or a commit-pinned
   * download. Only catalog paths are ever fetched.
   */
  async function file(id) {
    const product = state.products.find((p) => p.id === id);
    if (!product) return null;
    try {
      return {
        product,
        bytes: await fsp.readFile(
          path.join(cacheRoot, 'files', `${product.version}.kmz`),
        ),
      };
    } catch {
      /* not cached yet */
    }
    const commit = state.commit;
    let pending = downloads.get(product.version);
    if (!pending) {
      pending = (async () => {
        const response = await get(
          ghostMapsRawUrl(commit, product.path),
          { 'User-Agent': USER_AGENT },
          FILE_TIMEOUT_MS,
        );
        const bytes = Buffer.from(
          await readResponseBytesCapped(response, GHOSTMAPS_MAX_FILE_BYTES),
        );
        // A failed cache write must not turn a good download into a 502: the
        // installed desktop app cannot write beside its payload.
        await writeCache(async () => {
          const target = path.join(
            cacheRoot,
            'files',
            `${product.version}.kmz`,
          );
          await fsp.mkdir(path.dirname(target), { recursive: true });
          const temp = `${target}.${process.pid}.tmp`;
          await fsp.writeFile(temp, bytes);
          await fsp.rename(temp, target);
          await pruneFiles();
        });
        return bytes;
      })().finally(() => downloads.delete(product.version));
      downloads.set(product.version, pending);
    }
    return { product, bytes: await pending };
  }

  /** Keep only files that a current product still points to. */
  async function pruneFiles() {
    const keep = new Set(state.products.map((p) => `${p.version}.kmz`));
    const dir = path.join(cacheRoot, 'files');
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (!keep.has(name) && !name.endsWith('.tmp'))
        await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    start,
    stop,
    checkNow,
    catalog: publicCatalog,
    file,
    subscribe,
    subscribers: () => listeners.size,
  };
}

/** Same-origin GhostMaps routes for dev and preview. */
export function ghostMapsProxy({ watcher = createGhostMapsWatcher() } = {}) {
  const json = (res, status, value) => {
    if (res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(status === 405 ? { Allow: 'GET' } : {}),
    });
    res.end(JSON.stringify(value));
  };

  function events(req, res) {
    if (watcher.subscribers() >= MAX_SUBSCRIBERS)
      return json(res, 429, { error: 'too_many_subscribers' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (catalog) =>
      res.write(`event: catalog\ndata: ${JSON.stringify(catalog)}\n\n`);
    res.write('retry: 5000\n\n');
    send(watcher.catalog());
    const unsubscribe = watcher.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref?.();
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', close);
    res.on('error', close);
  }

  async function handler(req, res) {
    if (req.method !== 'GET')
      return json(res, 405, { error: 'method_not_allowed' });
    const url = new URL(req.url || '/', 'http://local');
    const match = /^\/file\/([a-z0-9-]{1,40})$/.exec(url.pathname);
    if (!['/catalog', '/events'].includes(url.pathname) && !match)
      return json(res, 404, { error: 'unknown_route' });
    // Watching starts with the first request, so an install that never turns
    // the layer on never contacts GitHub.
    const first = watcher.start();
    if (url.pathname === '/catalog') {
      if (!watcher.catalog().commit) await first;
      return json(res, 200, watcher.catalog());
    }
    if (url.pathname === '/events') return events(req, res);
    try {
      if (!watcher.catalog().commit) await first;
      const found = await watcher.file(match[1]);
      if (!found) return json(res, 404, { error: 'unknown_product' });
      const pinned = url.searchParams.get('v') === found.product.version;
      res.writeHead(200, {
        'Content-Type': 'application/vnd.google-earth.kmz',
        'Content-Length': found.bytes.length,
        'X-GhostMaps-Version': found.product.version,
        // A versioned URL names one immutable blob.
        'Cache-Control': pinned
          ? 'private, max-age=31536000, immutable'
          : 'no-store',
      });
      return res.end(found.bytes);
    } catch {
      return json(res, 502, { error: 'ghostmaps_unavailable' });
    }
  }

  return {
    name: 'ghostmaps',
    configureServer({ middlewares }) {
      middlewares.use('/api/ghostmaps', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/ghostmaps', handler);
    },
  };
}
