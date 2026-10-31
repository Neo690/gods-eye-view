/**
 * Vite plugin: the plate reader, on demand, for one selected camera.
 *
 *   POST /api/alpr   {"cameraId":"<registered camera id>"}
 *     -> { camera, plates, model, ms }
 *
 * The route reads the camera's own upstream still (`cctv.readSnapshot`), runs
 * the ported YOLOv9 + CCT ONNX pair over it, and answers with the plates it
 * found. Three deliberate constraints:
 *
 *   - Nothing is stored. A result lives in memory for a few seconds so a panel
 *     that redraws does not spend a second inference, and is gone with the
 *     process; no plate text is written to disk, to the log, or to the app's
 *     layer state.
 *   - The caller names a camera, never a URL. The image comes from the CCTV
 *     catalogue this server already serves, so the route cannot be used to make
 *     the host fetch an arbitrary address.
 *   - A missing model set is a 503 that says which step is missing, not a 500:
 *     the rest of the app keeps working without the reader.
 * @module server/providers/alpr
 */
import { admitSameSiteKeyless } from './common/same-site.js';
import { AlprUnavailable, readPlates } from '../alpr/engine.js';

/** Largest request body accepted: a camera id and nothing else. */
export const ALPR_BODY_LIMIT = 4096;

/** Longest camera id accepted, in characters. */
export const ALPR_CAMERA_ID_LIMIT = 200;

/** Two reads of the same camera closer than this share one answer. */
export const ALPR_CACHE_MS = 8000;

/** Shortest gap between two reads of the same camera, before caching. */
export const ALPR_MIN_INTERVAL_MS = 1200;

/** Read a small JSON body; `null` when it is over the limit or unreadable. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > ALPR_BODY_LIMIT) {
        chunks.length = 0;
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * @param {object} [options]
 * @param {{readSnapshot: Function}} [options.cctv] The CCTV provider instance;
 *   without it the route refuses, because it would have nothing to read.
 * @param {Function} [options.read] Plate reader, replaced by the tests.
 * @param {Function} [options.now] Clock, replaced by the tests.
 */
export function alprProxy({ cctv, read = readPlates, now = Date.now } = {}) {
  /** cameraId -> { at, result } */
  const cache = new Map();

  const install = (server) => {
    server.middlewares.use('/api/alpr', async (req, res) => {
      const json = (status, value, headers = {}) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...headers,
        });
        res.end(JSON.stringify(value));
      };

      if (req.method !== 'POST')
        return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
      // Same gate as the other keyless providers: a browser on another origin
      // has no business asking this host what a camera is looking at.
      if (admitSameSiteKeyless(req, res)) return;

      if (!cctv?.readSnapshot) {
        return json(503, {
          error: 'camera_source_unavailable',
          detail: 'The CCTV catalogue is not configured on this server.',
        });
      }

      const body = await readJsonBody(req);
      const cameraId =
        typeof body?.cameraId === 'string' ? body.cameraId.trim() : '';
      if (!cameraId || cameraId.length > ALPR_CAMERA_ID_LIMIT)
        return json(400, { error: 'camera_id_required' });

      const clock = now();
      const cached = cache.get(cameraId);
      if (cached && clock - cached.at < ALPR_CACHE_MS)
        return json(
          200,
          { ...cached.result, cached: true, ageMs: clock - cached.at },
          { 'x-alpr-cache': 'HIT' },
        );
      if (cached && clock - cached.at < ALPR_CACHE_MS + ALPR_MIN_INTERVAL_MS)
        return json(
          429,
          {
            error: 'too_soon',
            retryAfterMs:
              ALPR_CACHE_MS + ALPR_MIN_INTERVAL_MS - (clock - cached.at),
          },
          { 'Retry-After': '2' },
        );

      const frame = await cctv.readSnapshot(cameraId);
      if (!frame?.ok) {
        const status = frame?.reason === 'unknown-camera' ? 404 : 409;
        return json(status, { error: frame?.reason || 'frame_unavailable' });
      }

      try {
        const result = await read(frame.bytes);
        const payload = {
          camera: frame.camera,
          plates: result.plates,
          frame: result.frame,
          model: result.model,
          ms: result.ms,
          // Said in the answer rather than only in a document: whoever reads
          // this response should know the server kept nothing.
          retention: 'none',
        };
        cache.set(cameraId, { at: clock, result: payload });
        if (cache.size > 64) {
          for (const [key, entry] of cache)
            if (clock - entry.at > ALPR_CACHE_MS * 4) cache.delete(key);
        }
        // Counts only: a log that names plates would outlive the request.
        console.log(
          `[alpr] ${cameraId}: ${payload.plates.length} plate(s) in ${result.ms.total} ms`,
        );
        return json(
          200,
          { ...payload, cached: false },
          { 'x-alpr-cache': 'MISS' },
        );
      } catch (error) {
        if (error instanceof AlprUnavailable) {
          const missingModels =
            error.code === 'models_missing' || error.code === 'models_mismatch';
          return json(
            error.code === 'frame_too_small' ? 422 : 503,
            {
              error: error.code,
              detail: error.message,
              ...(missingModels
                ? { install: 'npm run alpr:models', ...error.details }
                : error.details),
            },
            missingModels ? { 'Retry-After': '600' } : {},
          );
        }
        console.warn('[alpr] read failed:', error?.name || 'Error');
        return json(502, { error: 'read_failed' });
      }
    });
  };

  return {
    name: 'alpr-reader',
    configureServer: install,
    configurePreviewServer: install,
  };
}
