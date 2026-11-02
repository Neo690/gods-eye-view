/**
 * Vite plugin: the face API, the same shape of contract the plate reader keeps.
 *
 *   POST /api/face/analyze    {"cameraId"}     -> {camera, count, faces, ...}
 *   POST /api/face/match      {"cameraId", "cohort"} -> {camera, matches, ...}
 *   POST /api/face/enroll     {"cohort","label","image"} -> {enrollment: {...}}
 *   DELETE /api/face/enrollments?id=          -> {removed}
 *   GET  /api/face/enrollments                -> {enrollments: [...]}
 *
 * Two features, one line between them:
 *
 *   - Analyze is non-identifying. It answers where faces are — boxes, scores,
 *     landmarks for the blur — and how many; no roster is consulted and no
 *     embeddings leave the process.
 *   - Match is consent-based, closed-base. It compares only against the
 *     enrollment cohort the caller names, and thresholds in cosine terms
 *     (`FACE_MATCH_THRESHOLD`); no one on a camera who has not been enrolled is
 *     ever named, and no external or global base exists in this module.
 *
 * Nothing on the camera side is stored. Like the plate reader, an answer lives
 * in memory for 8 s, and up to 60 s only while the camera republishes identical
 * bytes. One deliberate extra holds for enroll: the uploaded consent photo is
 * used for its embedding and then dropped — no copy is kept, the roster only
 * ever holds numbers and a label, and every answer route strips the embedding
 * before responding.
 * @module server/providers/face
 */
import { createHash } from 'node:crypto';
import { admitSameSiteKeyless } from './common/same-site.js';
import {
  cosineSimilarity,
  detectFaces,
  embedFace,
  FACE_MATCH_THRESHOLD,
  FaceUnavailable,
} from '../face/engine.js';
import {
  addEnrollment,
  cohortEnrollments,
  enrollmentsFile,
  readEnrollments,
  removeEnrollment,
} from '../face/enrollments.js';

/** Body ceilings: enrollments may carry a photo, everything else is small. */
export const FACE_BODY_LIMIT = 4096;
export const FACE_ENROLL_BODY_LIMIT = 2 * 1024 * 1024;

/** Longest camera id accepted, in characters. */
export const FACE_CAMERA_ID_LIMIT = 200;

/** Two reads of the same camera closer than this share one answer. */
export const FACE_CACHE_MS = 8000;

/** Shortest gap between two reads of the same camera. */
export const FACE_MIN_INTERVAL_MS = 1200;

/**
 * How long an answer may be reused while the camera republishes the same
 * bytes — the plate reader's contract, verbatim.
 */
export const FACE_FRAME_REUSE_MS = 60_000;

/** The response never carries embeddings; only lengths are diagnostic. */
function dropoutEnrollment({ embedding, label, cohort, ...rest }) {
  return {
    ...rest,
    label,
    cohort,
    embeddingLength: Array.isArray(embedding) ? embedding.length : 0,
  };
}

/** "data:<mime>;base64,<bytes>" -> {buffer, mime}; null when unusable. */
function parseDataUrl(text, bodyLimit) {
  if (typeof text !== 'string') return null;
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(
    text,
  );
  if (!match) return null;
  const [, mime, base64] = match;
  let bytes = null;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  if (!bytes.length || bytes.length > bodyLimit) return null;
  return { buffer: bytes, mime: `image/${mime}` };
}

/** Read a URL-safe JSON body with a per-endpoint ceiling. */
function readJsonBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
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

/** Fingerprint of a frame, to tell a republished still from a new one. */
function fingerprint(bytes) {
  return createHash('sha256').update(bytes).digest('base64url');
}

/**
 * Read the camera snapshot, kept in memory only.
 * `cctv` is the provider instance the local server hands in; nothing is
 * fetched from a URL the request names, ever.
 */
async function readCamera(device, cctv) {
  if (typeof cctv?.readSnapshot !== 'function')
    throw new Error('cctv provider has no readSnapshot');
  const result = await cctv.readSnapshot(device);
  // A snapshot is either the pixels themselves or an object ({buffer, mime,
  // ...}) wrapping them. The property probe has to stay shape-led, because a
  // Buffer *has* a `.buffer` (its ArrayBuffer) and `.length` would bore through
  // into the wrong type.
  if (result && (result instanceof Buffer || result instanceof Uint8Array))
    return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
  const buffer = result?.buffer instanceof Buffer ? result.buffer : null;
  if (!buffer?.length)
    return result?.image instanceof Buffer ? result.image : null;
  return buffer;
}

/** The route's error text, matched to the plate reader's tone. */
function errorResponse(status, error, detail) {
  return {
    status,
    body: { error, detail: String(detail || '') },
  };
}

/** @param {{cctv:object, detect?:Function, embed?:Function,
 *  enroll?:Function, now?:Function}} [options] */
export function faceProxy({
  cctv,
  detect = detectFaces,
  embed = embedFace,
  enroll = addEnrollment,
  now = Date.now,
} = {}) {
  /** cameraId -> { at, result }: the answer reuse window. */
  const cache = new Map();
  /** cameraId -> { hash, at, result }: answers tied to one set of pixels. */
  const answers = new Map();

  /**
   * Bounded per-camera throttle and the two reuse windows, exactly as the
   * plate reader keeps. Analyze and match share one access, one read.
   */
  const ticker = () => Math.floor(now());

  const track = () => {
    const readOnceEvery = 60_000;
    const oneMoreMinute = 30_000;
    for (const [key, val] of cache)
      if (!key || !val || ticker() - val.at > oneMoreMinute) cache.delete(key);
    for (const [key, val] of answers)
      if (!key || !val || ticker() - val.at > readOnceEvery + 30_000)
        answers.delete(key);
  };

  const toFrameKey = (cameraId) => `${cameraId}`;

  const read = async (cameraId, past = {}) => {
    const cameraIdString = String(cameraId || '');
    if (!cameraIdString || cameraIdString.length > FACE_CAMERA_ID_LIMIT)
      return errorResponse(400, 'no_camera', 'A camera id is required');
    if (!cctv)
      return errorResponse(
        500,
        'config',
        'The face route has no cctv attached',
      );
    const at = now();
    track();
    const cached = cache.get(toFrameKey(cameraIdString));
    if (cached && !past.force && at - cached.at < FACE_CACHE_MS)
      return { status: 200, body: { ...cached.result, cached: true } };
    const sameFrame = answers.get(toFrameKey(cameraIdString));
    if (sameFrame && at - sameFrame.at < FACE_FRAME_REUSE_MS) {
      cache.set(toFrameKey(cameraIdString), { at, result: sameFrame.result });
      return { status: 200, body: { ...sameFrame.result, cached: true } };
    }
    if (cached && at - cached.at < FACE_MIN_INTERVAL_MS)
      return {
        status: 429,
        body: {
          error: 'too_soon',
          detail: 'The camera is being read again shortly',
        },
      };

    let bytes = null;
    try {
      bytes = await readCamera(cameraIdString, cctv);
    } catch (error) {
      return errorResponse(502, 'camera_fetch', error?.message || error);
    }
    if (!bytes)
      return errorResponse(502, 'camera_fetch', 'The camera answered nothing');
    const hash = fingerprint(bytes);
    if (
      sameFrame &&
      sameFrame.hash === hash &&
      at - sameFrame.at < FACE_FRAME_REUSE_MS
    )
      return { status: 200, body: { ...sameFrame.result, cached: true } };

    return { status: 200, bytes, hash, at, cameraId: cameraIdString };
  };

  /** Whether the caller is admitted at all (same-site stays the gate).
   * The gate answers a 403 itself when it refuses, and returns true then. */
  const admitted = (req, res) => admitSameSiteKeyless(req, res);

  /** Shape of two answers and everything shared between them. */
  const runAnalysis = async ({ cameraId, past = {}, cohort = null } = {}) => {
    const call = await read(cameraId, past);
    // A cached success and every refusal come back as {status, body}; only a
    // fresh read carries the raw bytes onward.
    if (call?.body) return call;
    const { bytes, hash, at, cameraId: cameraIdString } = call;
    try {
      const analysis = await detect(bytes, {});
      const base = {
        camera: { id: cameraIdString },
        frame: analysis.frame,
        model: analysis.model,
        ms: analysis.ms,
        count: analysis.faces.length,
        faces: analysis.faces.map(({ score, box, landmarks }) => ({
          score: Math.round(1000 * score) / 1000,
          box: {
            x1: Math.round(box.x1),
            y1: Math.round(box.y1),
            x2: Math.round(box.x2),
            y2: Math.round(box.y2),
          },
          landmarks: [
            ...landmarks.map(({ x, y }) => ({
              x: Math.round(x),
              y: Math.round(y),
            })),
          ],
        })),
      };
      let matches = [];
      if (cohort !== null) {
        const roster = await cohortEnrollments(cohort, {});
        if (roster.error)
          return errorResponse(400, roster.error, roster.message || '');
        matches = [];
        for (const face of analysis.faces) {
          const { embedding } = await embed(bytes, face, {});
          let best = null;
          for (const known of roster.enrollments) {
            const similarity = cosineSimilarity(embedding, known.embedding);
            if (!best || similarity > best.similarity)
              best = {
                label: known.label,
                id: known.id,
                similarity: Math.round(10000 * similarity) / 10000,
              };
          }
          matches.push({
            ...face,
            match:
              best && best.similarity >= FACE_MATCH_THRESHOLD ? best : null,
            best: best
              ? { ...best, matched: best.similarity >= FACE_MATCH_THRESHOLD }
              : null,
          });
        }
      }
      const thresholdNote = matches.length
        ? FACE_MATCH_THRESHOLD
        : cohort !== null
          ? FACE_MATCH_THRESHOLD
          : undefined;
      const result = matches.length
        ? { ...base, matches, matchThreshold: thresholdNote }
        : base;
      cache.set(toFrameKey(cameraIdString), { at, result });
      answers.set(toFrameKey(cameraIdString), { at, hash, result });
      return { status: 200, body: { ...result, cached: false } };
    } catch (error) {
      if (error instanceof FaceUnavailable && error.code === 'frame_too_small')
        return errorResponse(415, 'frame_too_small', error.message);
      if (
        error instanceof FaceUnavailable &&
        ['models_missing', 'models_mismatch', 'runtime_missing'].includes(
          error.code,
        )
      ) {
        const detail =
          error.code === 'runtime_missing'
            ? 'Install onnxruntime-node and sharp to use the face module'
            : `Run \`npm run face:models\` (see ${error.details?.directory})`;
        return errorResponse(503, error.code, detail);
      }
      console.error('[face] analysis failed:', error?.message || error);
      return errorResponse(500, 'face_failed', error?.message || error);
    }
  };

  /** Handle the JSON endpoints the URL names. */
  const respond = async (req, res) => {
    const requestUrl = new URL(req.url, 'http://same-site');
    if (admitted(req, res))
      return {
        status: res.statusCode,
        body: { error: 'origin_denied', detail: '' },
      };
    if (requestUrl.pathname === '/api/face/enrollments') {
      if (req.method === 'GET') {
        const { enrollments } = await readEnrollments(enrollmentsFile());
        return {
          status: 200,
          body: { enrollments: enrollments.map(dropoutEnrollment) },
        };
      }
      if (req.method === 'DELETE') {
        const id = requestUrl.searchParams.get('id') ?? '';
        const outcome = await removeEnrollment(id);
        if (outcome.error)
          return errorResponse(400, outcome.error, outcome.message || '');
        return { status: 200, body: { removed: outcome.removed } };
      }
      return errorResponse(405, 'method', 'GET or DELETE only');
    }
    if (!req.method || req.method !== 'POST')
      return errorResponse(405, 'method', 'POST only');
    const isEnroll = requestUrl.pathname === '/api/face/enroll';
    if (
      requestUrl.pathname !== '/api/face/analyze' &&
      requestUrl.pathname !== '/api/face/match' &&
      !isEnroll
    )
      return null;
    const payload = await readJsonBody(
      req,
      isEnroll ? FACE_ENROLL_BODY_LIMIT : FACE_BODY_LIMIT,
    );
    if (isEnroll) {
      const image = parseDataUrl(payload?.image, FACE_ENROLL_BODY_LIMIT);
      const cohort = String(payload?.cohort ?? '').trim();
      const label = String(payload?.label ?? '').trim();
      if (!image)
        return errorResponse(
          400,
          'image_invalid',
          'An image data URL (jpeg/png/webp) is required',
        );
      if (!cohort)
        return errorResponse(400, 'cohort_required', 'A cohort is required');
      try {
        const { faces } = await detect(image.buffer, { maxFaces: 1 });
        if (!faces.length)
          return errorResponse(
            400,
            'no_face',
            'No face in the image, so nothing could be enrolled',
          );
        const { embedding } = await embed(image.buffer, faces[0], {});
        const outcome = await enroll({ label, cohort, embedding }, {});
        if (outcome.error)
          return errorResponse(400, outcome.error, outcome.message || '');
        return {
          status: 200,
          body: { enrollment: dropoutEnrollment(outcome.enrollment) },
        };
      } catch (error) {
        if (
          error instanceof FaceUnavailable &&
          ['models_missing', 'models_mismatch', 'runtime_missing'].includes(
            error.code,
          )
        )
          return errorResponse(
            503,
            error.code,
            'Run `npm run face:models` first',
          );
        return errorResponse(500, 'face_failed', error?.message || error);
      }
    }
    const cameraId = payload?.cameraId;
    if (typeof cameraId !== 'string' || !cameraId)
      return errorResponse(400, 'no_camera', 'A camera id is required');
    return runAnalysis({
      cameraId,
      cohort: requestUrl.pathname === '/api/face/match' ? payload.cohort : null,
    });
  };

  /** The Vite plugin shape: one middleware, same as the plate reader's. */
  const install = (server) => {
    server.middlewares.use(async (req, res, next) => {
      try {
        const url = new URL(req.url ?? '/', 'http://same-site');
        if (!url.pathname.startsWith('/api/face')) return next();
        const responded = await respond(req, res);
        if (!responded) return next();
        res.statusCode = responded.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(responded.body));
      } catch (error) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            error: 'face_failed',
            detail: error?.message || String(error),
          }),
        );
      }
    });
  };
  return {
    name: 'face-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}

export { enrollmentsFile as faceEnrollmentsFile };
