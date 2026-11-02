/**
 * The face engine: two ONNX sessions and the pixels between them.
 *
 * `onnxruntime-node` and `sharp` are optional dependencies, imported the way
 * the plate reader imports them (`server/alpr/engine.js`): lazily, so a server
 * that never sees a camera frame does not pay for their native binaries, and
 * their absence is a typed refusal, not a boot crash. Sessions are created once
 * per model directory and reused.
 *
 * Nothing here decides anything about identity. It answers three questions for
 * the route, from pixels:
 *
 *   - `detectFaces(image)` — every face it can see, as boxes, scores and five
 *     landmarks, in frame coordinates. This is the analysis the privacy blur
 *     and the presence counts run on.
 *   - `embedFace(image, face)` — a 512-d embedding of one already-detected
 *     face, landmark-aligned the way the recognizer was trained.
 *   - `cosineSimilarity(a, b)` — the only comparison allowed between an
 *     embedding and a roster. Comparisons happen against an explicit opt-in
 *     roster (`server/face/enrollments.js`), never against any external base.
 * @module server/face/engine
 */
import fs from 'node:fs/promises';
import {
  FACE_DETECTOR_SIZE,
  modelPaths,
  modelsDirectory,
  inspectModels,
} from './models.js';
import {
  ARC_LANDMARKS,
  FACE_MIN_SCORE,
  keepBestFaces,
  decodeScrfdStride,
  similarityTransform,
  SCRFD_STRIDES,
  unscaleFaces,
} from './detector.js';

/** Largest accepted image: a CCTV frame is never bigger than this. */
export const FACE_MAX_PIXELS = 4096 * 4096;

/** Embedding dimensionality, retained for a shape check on first use. */
export const FACE_EMBEDDING_DIMENSIONS = 512;

/**
 * Cosine a match must at least show before a detected face is called one of
 * the enrolled. Calibrated on held portraits: the same person re-packaged stays
 * above 0.97, different people top out near 0.56 (formal black-and-white
 * headshots are the base-rate ceiling), and the midpoint minus a margin is the
 * line — a mistaken "hello" is worse than a missed one, because the roster is
 * the operator's own and the reuse is theirs to extend, not to lose.
 */
export const FACE_MATCH_THRESHOLD = 0.62;

/** Why the engine cannot answer, in terms the route can translate. */
export class FaceUnavailable extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FaceUnavailable';
    this.code = code;
    this.details = details;
  }
}

/** Sessions for one model directory, kept between requests. */
const engines = new Map();

/**
 * Threads a cgroup quota actually allows, for the same reason the plate
 * reader limits onnxruntime to it: `os.cpus()` reports the host, the quota is
 * what the container gets, and a dozen threads on a tenth of a core thrash.
 *
 * @param {string} quota Contents of cpu.max, or of cgroup v1's pair.
 * @param {number} [periodMicros] cgroup v1 period.
 * @returns {number|null} Whole cores, at least one; null when undeterminable.
 */
export function threadsForCgroupQuota(quota, periodMicros) {
  const text = String(quota ?? '').trim();
  if (!text || text.startsWith('max')) return null;
  const parts = text.split(/\s+/);
  const allowance = Number(parts[0]);
  const period = Number(parts[1] ?? periodMicros);
  if (!Number.isFinite(allowance) || allowance <= 0) return null;
  if (!Number.isFinite(period) || period <= 0) return null;
  return Math.max(1, Math.floor(allowance / period));
}

/** Read the cgroup's CPU quota, when the platform has one. */
async function cpuQuotaThreads() {
  const read = async (file) => {
    try {
      return await fs.readFile(file, 'utf8');
    } catch {
      return null;
    }
  };
  const v2 = await read('/sys/fs/cgroup/cpu.max');
  if (v2 !== null) return threadsForCgroupQuota(v2);
  const quota = await read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const period = await read('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  if (quota === null) return null;
  const micros = Number(String(period ?? '').trim());
  return threadsForCgroupQuota(
    quota,
    Number.isFinite(micros) ? micros : undefined,
  );
}

async function importRuntime() {
  let ort = null;
  let sharp = null;
  try {
    ort = await import('onnxruntime-node');
  } catch {
    ort = null;
  }
  try {
    sharp = (await import('sharp')).default;
  } catch {
    sharp = null;
  }
  return { ort, sharp };
}

/** Build the two sessions from a verified model directory. */
async function buildEngine(directory) {
  const report = await inspectModels(directory);
  if (!report.ok)
    throw new FaceUnavailable(
      report.mismatched.length ? 'models_mismatch' : 'models_missing',
      'The face models are not installed',
      {
        directory: report.directory,
        missing: report.missing,
        mismatched: report.mismatched,
      },
    );
  const { ort, sharp } = await importRuntime();
  if (!ort || !sharp)
    throw new FaceUnavailable(
      'runtime_missing',
      'onnxruntime-node and sharp are required for face analysis',
      { onnxruntime: Boolean(ort), sharp: Boolean(sharp) },
    );

  const files = modelPaths(directory);
  const threads = await cpuQuotaThreads();
  const options = {
    executionProviders: ['cpu'],
    ...(threads
      ? { intraOpNumThreads: threads, interOpNumThreads: threads }
      : {}),
  };
  if (threads)
    console.log(
      `[face] cgroup allows ${threads} core(s); onnxruntime limited to that`,
    );
  const [detector, recognizer] = await Promise.all([
    ort.InferenceSession.create(files.detector, options),
    ort.InferenceSession.create(files.recognizer, options),
  ]);
  return { ort, sharp, detector, recognizer, directory };
}

/**
 * Resolve (and cache) the engine for a model directory.
 *
 * @param {string} [directory] Overrides `GEV_FACE_MODELS_DIR`.
 * @returns {Promise<object>} The engine, or a `FaceUnavailable` rejection.
 */
export function getEngine(directory = modelsDirectory()) {
  const key = String(directory);
  const cached = engines.get(key);
  if (cached) return cached;
  const pending = buildEngine(directory).catch((error) => {
    // A failed build must not pin the failure: installing the models should be
    // enough to make the next request work, without restarting the server.
    engines.delete(key);
    throw error;
  });
  engines.set(key, pending);
  return pending;
}

/** Drop cached sessions; the tests use this, the route never does. */
export function resetEngines() {
  engines.clear();
}

/** True when the frame is big enough for the detector to mean anything. */
function usableFrame(info) {
  return info?.width >= 64 && info?.height >= 64;
}

/**
 * Decode one image into pixels the engine can crop from — RGB, unrotated,
 * with EXIF rotation already applied.
 *
 * @param {Buffer|Uint8Array} image Encoded JPEG/PNG/WebP bytes.
 * @param {object} sharp
 */
async function decodeImage(image, sharp) {
  const decoded = await sharp(Buffer.from(image), {
    limitInputPixels: FACE_MAX_PIXELS,
  })
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const frame = { width: decoded.info.width, height: decoded.info.height };
  if (!usableFrame(frame))
    throw new FaceUnavailable('frame_too_small', 'Frame is too small to read');
  return { decoded, frame };
}

/**
 * Fit the frame into the detector's square input, and remember where the
 * edges went so decoded coordinates can come back.
 *
 * @param {object} sharp
 * @param {{data:Buffer, info:{width:number, height:number}}} decoded
 * @returns {{pose:object, tensor:Float32Array}}
 */
async function letterboxedTensor(sharp, decoded) {
  const size = FACE_DETECTOR_SIZE;
  const { width: W, height: H } = decoded.info;
  const scale = Math.min(size / W, size / H);
  const scaledWidth = Math.max(1, Math.round(W * scale));
  const scaledHeight = Math.max(1, Math.round(H * scale));
  const pose = {
    scale,
    padX: (size - scaledWidth) / 2,
    padY: (size - scaledHeight) / 2,
    scaledWidth,
    scaledHeight,
  };
  const resized = await sharp(decoded.data, {
    raw: { width: W, height: H, channels: 3 },
  })
    .resize({
      width: scaledWidth,
      height: scaledHeight,
      kernel: 'linear',
      fit: 'fill',
    })
    .raw()
    .toBuffer();
  const canvas = Buffer.alloc(size * size * 3, 0);
  for (let row = 0; row < scaledHeight; row += 1)
    resized.copy(
      canvas,
      ((Math.round(pose.padY) + row) * size + Math.round(pose.padX)) * 3,
      row * scaledWidth * 3,
      (row + 1) * scaledWidth * 3,
    );
  // SCRFD maps (px - 127.5) / 127.5 over NCHW BGR planes.
  const tensor = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let i = 0; i < plane; i += 1) {
    const pixel = i * 3;
    tensor[i] = (canvas[pixel + 2] - 127.5) / 127.5; // B
    tensor[plane + i] = (canvas[pixel + 1] - 127.5) / 127.5; // G
    tensor[2 * plane + i] = (canvas[pixel] - 127.5) / 127.5; // R
  }
  return { pose, tensor };
}

/**
 * Every face in one image, annotated the way the recognizer wants.
 *
 * @param {Buffer|Uint8Array} image Encoded JPEG/PNG/WebP bytes.
 * @param {{directory?:string, threshold?:number, maxFaces?:number}} [options]
 * @returns {Promise<{faces:Array<{score:number, box:object,
 *   landmarks:Array<{x:number,y:number}>}>, frame:object, model:object,
 *   ms:object}>}
 */
export async function detectFaces(image, options = {}) {
  if (!image || !image.length) throw new TypeError('An image is required');
  const started = Date.now();
  const engine = await getEngine(options.directory);
  const { ort, sharp, detector } = engine;
  const threshold = Number.isFinite(options.threshold)
    ? Math.max(options.threshold, FACE_MIN_SCORE)
    : FACE_MIN_SCORE;
  const maxFaces = Math.max(1, Math.min(64, options.maxFaces || 24));

  const { decoded, frame } = await decodeImage(image, sharp);
  const decodeMs = Date.now() - started;
  const { pose, tensor } = await letterboxedTensor(sharp, decoded);

  const detectorStarted = Date.now();
  const output = await detector.run({
    [detector.inputNames[0]]: new ort.Tensor('float32', tensor, [
      1,
      3,
      FACE_DETECTOR_SIZE,
      FACE_DETECTOR_SIZE,
    ]),
  });
  const names = detector.outputNames;
  const raw = [];
  SCRFD_STRIDES.forEach((stride, index) => {
    const scoreTensor = output[names[index]];
    const boxTensor = output[names[index + 3]];
    const kpsTensor = output[names[index + 6]];
    if (!scoreTensor || !boxTensor || !kpsTensor) return;
    const count = scoreTensor.data.length;
    raw.push(
      ...decodeScrfdStride(
        {
          scores: scoreTensor.data,
          boxes: boxTensor.data,
          kps: kpsTensor.data,
          count,
        },
        stride,
        { threshold, size: FACE_DETECTOR_SIZE },
      ),
    );
  });
  const faces = unscaleFaces(keepBestFaces(raw, { limit: maxFaces }), pose);
  const detectorMs = Date.now() - detectorStarted;

  return {
    faces,
    frame,
    model: {
      detector: 'scrfd-500m (buffalo_s)',
      recognizer: 'w600k-mbf (buffalo_s)',
      input: FACE_DETECTOR_SIZE,
    },
    ms: { decode: decodeMs, detector: detectorMs, total: Date.now() - started },
  };
}

/** Crop one face, landmark-aligned, into the recognizer's 112x112 canvas. */
async function alignedCrop(sharp, decoded, face, { size = 112 } = {}) {
  const transform = similarityTransform(face.landmarks, ARC_LANDMARKS);
  const { data: raw } = decoded;
  const srcWidth = decoded.info.width;
  const srcHeight = decoded.info.height;
  const determinant = transform.ax * transform.by - transform.ay * transform.bx;
  const crop = Buffer.alloc(size * size * 3, 127);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Inverse map: source = adj(M) (target - t) / det(M).
      const rx = x - transform.tx;
      const ry = y - transform.ty;
      const sxr = (transform.by * rx - transform.ay * ry) / determinant;
      const syr = (-transform.bx * rx + transform.ax * ry) / determinant;
      const sx = Math.round(sxr);
      const sy = Math.round(syr);
      const target = (y * size + x) * 3;
      if (sx < 0 || sy < 0 || sx >= srcWidth || sy >= srcHeight) continue;
      const source = (sy * srcWidth + sx) * 3;
      crop[target] = raw[source];
      crop[target + 1] = raw[source + 1];
      crop[target + 2] = raw[source + 2];
    }
  }
  return crop;
}

/**
 * A 512-d embedding for one detected face of the same image.
 *
 * @param {Buffer|Uint8Array} image The same bytes `detectFaces` saw.
 * @param {{box:object, landmarks:Array<{x:number,y:number}>}} face
 * @param {{directory?:string}} [options]
 * @returns {Promise<{embedding:Float32Array, model:object}>}
 */
export async function embedFace(image, face, options = {}) {
  if (!image || !image.length) throw new TypeError('An image is required');
  if (!face?.landmarks || face.landmarks.length !== 5)
    throw new FaceUnavailable(
      'unusable_face',
      'A face needs five landmarks to be embedded',
    );
  const engine = await getEngine(options.directory);
  const { ort, sharp, recognizer } = engine;
  const { decoded } = await decodeImage(image, sharp);
  const crop = await alignedCrop(sharp, decoded, face);
  const tensor = new Float32Array(3 * 112 * 112);
  const plane = 112 * 112;
  for (let i = 0; i < plane; i += 1) {
    tensor[i] = (crop[i * 3] - 127.5) / 127.5; // R
    tensor[plane + i] = (crop[i * 3 + 1] - 127.5) / 127.5; // G
    tensor[2 * plane + i] = (crop[i * 3 + 2] - 127.5) / 127.5; // B
  }
  const output = await recognizer.run({
    [recognizer.inputNames[0]]: new ort.Tensor(
      'float32',
      tensor,
      [1, 3, 112, 112],
    ),
  });
  const embedding = output[recognizer.outputNames[0]]?.data;
  if (!embedding || embedding.length !== FACE_EMBEDDING_DIMENSIONS)
    throw new FaceUnavailable(
      'embedding_failed',
      'The recognizer did not answer an embedding',
    );
  return { embedding: Float32Array.from(embedding) };
}

/**
 * Cosine similarity between two 512-d embeddings.
 *
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {number} In [-1, 1]; 0 for malformed input, never a throw.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / Math.sqrt(normA * normB);
}
