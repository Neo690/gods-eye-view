/**
 * The plate reader: two ONNX sessions and the pixels between them.
 *
 * `onnxruntime-node` and `sharp` are optional dependencies. They carry native
 * binaries (roughly 100 MB between them) that a checkout which never reads a
 * plate should not pay for, so they are imported lazily and their absence is a
 * typed refusal rather than a crash at boot.
 *
 * Sessions are created once per model directory and reused: loading 11 MB of
 * weights costs about a second, and a camera re-read a few seconds later must
 * not pay it again.
 * @module server/alpr/engine
 */
import fs from 'node:fs/promises';
import {
  ALPR_DETECTOR_SIZE,
  modelPaths,
  modelsDirectory,
  inspectModels,
} from './models.js';
import {
  LETTERBOX_FILL,
  TILE_MAX_COUNT,
  decodeDetections,
  letterboxPose,
  mergeBoxes,
  planTiles,
} from './detector.js';
import { decodePlate, parsePlateConfig } from './ocr.js';

/** Longest side accepted, in pixels: a CCTV frame is never bigger than this. */
export const ALPR_MAX_PIXELS = 4096 * 4096;

/** Plates read per frame; a wide shot of a car park is not the target case. */
export const ALPR_MAX_PLATES = 6;

/** Detector floor. The model's own default is 0.25; a camera frame is noisier. */
export const ALPR_DETECT_THRESHOLD = 0.4;

/**
 * How sure the OCR has to be before a reading is called a plate.
 *
 * Tiling made the detector fire on things a downscaled frame used to blur
 * away: a camera's own station label came back as `T_F17` at 0.21, and a road
 * marking as `1FF849` at 0.36. Both carry letters and digits, so `looksLikePlate`
 * cannot tell them apart from a registration — only the OCR's confidence does.
 * Read well, a plate lands near 0.9; half-sure is the line, because a guess
 * shown as a car's registration is worse than a plate missed, and the frame is
 * on screen for anyone who wants to check by eye.
 */
export const ALPR_MIN_PLATE_CONFIDENCE = 0.5;

/** Why the reader cannot answer, in terms the route can translate. */
export class AlprUnavailable extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AlprUnavailable';
    this.code = code;
    this.details = details;
  }
}

/** Sessions for one model directory, kept between requests. */
const engines = new Map();

/**
 * Threads a cgroup quota actually allows.
 *
 * A container is usually given a fraction of a core while `os.cpus()` still
 * reports the host's full count, and onnxruntime sizes its intra-op pool from
 * that count: a dozen threads on a tenth of a core spend their time switching
 * instead of multiplying. The quota is the only honest source, and `null` means
 * "no quota to read", where the runtime's own choice is right.
 *
 * @param {string} quota Contents of `cpu.max` (`"5000 100000"`, `"max 100000"`)
 *   or of cgroup v1's `cpu.cfs_quota_us` / `cpu.cfs_period_us`.
 * @param {number} [periodMicros] cgroup v1 period, when the quota is a number.
 * @returns {number|null} Whole cores the quota allows, at least one.
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
    throw new AlprUnavailable(
      report.mismatched.length ? 'models_mismatch' : 'models_missing',
      'The plate reader models are not installed',
      {
        directory: report.directory,
        missing: report.missing,
        mismatched: report.mismatched,
      },
    );
  const { ort, sharp } = await importRuntime();
  if (!ort || !sharp)
    throw new AlprUnavailable(
      'runtime_missing',
      'onnxruntime-node and sharp are required to read plates',
      { onnxruntime: Boolean(ort), sharp: Boolean(sharp) },
    );

  const files = modelPaths(directory);
  const config = parsePlateConfig(await fs.readFile(files.ocrConfig, 'utf8'));
  const threads = await cpuQuotaThreads();
  const options = {
    executionProviders: ['cpu'],
    ...(threads
      ? { intraOpNumThreads: threads, interOpNumThreads: threads }
      : {}),
  };
  if (threads)
    console.log(
      `[alpr] cgroup allows ${threads} core(s); onnxruntime limited to that`,
    );
  const [detector, ocr] = await Promise.all([
    ort.InferenceSession.create(files.detector, options),
    ort.InferenceSession.create(files.ocr, options),
  ]);
  return { ort, sharp, config, detector, ocr, directory };
}

/**
 * Resolve (and cache) the engine for a model directory.
 *
 * @param {string} [directory] Overrides `GEV_ALPR_MODELS_DIR`.
 * @returns {Promise<object>} The engine, or an `AlprUnavailable` rejection.
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

/** True when the frame is tall enough for the detector to see a plate. */
function usableFrame(info) {
  return info?.width >= 32 && info?.height >= 32;
}

/**
 * Whether decoded text can be a plate at all.
 *
 * The detector fires on any small bright rectangle, and a traffic camera's own
 * overlay — an operator logo, a city name, a clock — is exactly that. Scanning
 * 48 real public cameras produced `WSDOT` at 0.99 OCR confidence (a sign the
 * model was certain about) and `010526`, a timestamp. Both are overlays, not
 * registrations.
 *
 * A plate carries letters and digits together: `AB-123-CD`, `5AU5341`,
 * `AB1234`. Text with only one of the two is either a station ident or a date,
 * so it is dropped. The cost is real and deliberate: a handful of
 * jurisdictions issue all-numeric registrations, and those would be missed —
 * but showing a clock as a car's plate is worse than missing an unusual plate,
 * and the frame is on screen for anyone who wants to check by eye.
 *
 * Length is the second filter, and it is what tiling made necessary: a tile
 * read a green street sign ("Colorado / 300 ST 200") as `COI0T0Q00T`, ten
 * characters of a caption, not of a registration. The longest registrations
 * this reader can meet carry nine alphanumerics (`AB-123-CD` is eight, a Dutch
 * `12-ABC-3` seven), so anything longer is a line of text on a sign or a
 * watermark, and anything shorter than four is a fragment.
 *
 * @param {string} text Decoded OCR text.
 * @returns {boolean} True when the text could be a plate.
 */
export function looksLikePlate(text) {
  if (typeof text !== 'string') return false;
  const glyphs = text.replace(/[^A-Za-z0-9]/g, '');
  if (glyphs.length < 4 || glyphs.length > 9) return false;
  return /\d/.test(glyphs) && /[A-Za-z]/.test(glyphs);
}

/**
 * Read every plate in one image.
 *
 * A frame larger than the detector's square input is read twice over: once
 * whole, which is how a plate close to the camera is found, and once per tile
 * at native resolution, which is the only way a plate 145 m away survives —
 * shrunk into 384 px it is two pixels wide and the detector cannot see it. The
 * passes are the same weights over different pixels, so their boxes are merged
 * before OCR: one car is one answer.
 *
 * @param {Buffer|Uint8Array} image Encoded JPEG/PNG/WebP bytes.
 * @param {{directory?:string, maxPlates?:number, threshold?:number,
 *   maxTiles?:number}} [options] `maxTiles` at 1 reads the frame in one pass.
 * @returns {Promise<{plates:Array<{text:string, confidence:number,
 *   box:{x1:number,y1:number,x2:number,y2:number}, boxScore:number}>,
 *   frame:{width:number,height:number}, model:object, passes:number,
 *   ms:{decode:number,detector:number,ocr:number,total:number}}>}
 */
export async function readPlates(image, options = {}) {
  if (!image || !image.length) throw new TypeError('An image is required');
  const started = Date.now();
  const engine = await getEngine(options.directory);
  const { sharp, ort, config, detector, ocr } = engine;
  const maxPlates = Math.max(1, options.maxPlates || ALPR_MAX_PLATES);
  const threshold = Number.isFinite(options.threshold)
    ? options.threshold
    : ALPR_DETECT_THRESHOLD;
  const maxTiles = Number.isFinite(options.maxTiles)
    ? options.maxTiles
    : TILE_MAX_COUNT;

  const decoded = await sharp(Buffer.from(image), {
    limitInputPixels: ALPR_MAX_PIXELS,
  })
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const frame = { width: decoded.info.width, height: decoded.info.height };
  if (!usableFrame(frame))
    throw new AlprUnavailable('frame_too_small', 'Frame is too small to read');
  const decodeMs = Date.now() - started;

  const source = { width: frame.width, height: frame.height, channels: 3 };

  /**
   * One detector run over one rectangle of the frame, in frame coordinates.
   *
   * The crop is cut from the already-decoded pixels rather than re-decoded, and
   * is letterboxed exactly as open-image-models does: bilinear resize, then pad
   * with 114.
   */
  const detectIn = async (rect) => {
    const size = ALPR_DETECTOR_SIZE;
    const whole =
      rect.left === 0 &&
      rect.top === 0 &&
      rect.width === frame.width &&
      rect.height === frame.height;
    const pixels = whole
      ? decoded.data
      : await sharp(decoded.data, { raw: source })
          .extract(rect)
          .raw()
          .toBuffer();

    const pose = letterboxPose(rect.width, rect.height, size);
    const resized = await sharp(pixels, {
      raw: { width: rect.width, height: rect.height, channels: 3 },
    })
      .resize({
        width: pose.scaledWidth,
        height: pose.scaledHeight,
        kernel: 'linear',
        fit: 'fill',
      })
      .raw()
      .toBuffer();
    const canvas = Buffer.alloc(size * size * 3, LETTERBOX_FILL);
    const left = Math.round(pose.padX - 0.1);
    const top = Math.round(pose.padY - 0.1);
    for (let row = 0; row < pose.scaledHeight; row += 1)
      resized.copy(
        canvas,
        ((top + row) * size + left) * 3,
        row * pose.scaledWidth * 3,
        (row + 1) * pose.scaledWidth * 3,
      );

    const tensor = new Float32Array(3 * size * size);
    const plane = size * size;
    for (let index = 0; index < plane; index += 1) {
      const pixel = index * 3;
      tensor[index] = canvas[pixel] / 255; // R
      tensor[plane + index] = canvas[pixel + 1] / 255; // G
      tensor[2 * plane + index] = canvas[pixel + 2] / 255; // B
    }

    const output = await detector.run({
      [detector.inputNames[0]]: new ort.Tensor('float32', tensor, [
        1,
        3,
        size,
        size,
      ]),
    });
    const rows = output[detector.outputNames[0]] ?? output.output0;
    // A box that reaches a tile edge which is not a frame edge was cut by the
    // tiling: the plate continues into the neighbouring tile, which sees it
    // whole. Marked here, where the tile's own coordinates are still known.
    // Only the exact border counts — a box one pixel inside is a box the model
    // ended where it meant to, and calling that truncated would throw away a
    // plate the tile did read.
    const cutLeft = rect.left > 0;
    const cutTop = rect.top > 0;
    const cutRight = rect.left + rect.width < frame.width;
    const cutBottom = rect.top + rect.height < frame.height;
    return decodeDetections(
      { data: rows.data, dims: rows.dims },
      pose,
      { width: rect.width, height: rect.height },
      { threshold, limit: maxPlates },
    ).map((box) => ({
      ...box,
      truncated:
        (cutLeft && box.x1 <= 0) ||
        (cutTop && box.y1 <= 0) ||
        (cutRight && box.x2 >= rect.width) ||
        (cutBottom && box.y2 >= rect.height),
      x1: box.x1 + rect.left,
      y1: box.y1 + rect.top,
      x2: box.x2 + rect.left,
      y2: box.y2 + rect.top,
    }));
  };

  const passes = [
    { left: 0, top: 0, width: frame.width, height: frame.height },
    ...planTiles(frame, { size: ALPR_DETECTOR_SIZE, maxTiles }),
  ];

  const detectorStarted = Date.now();
  const found = [];
  for (const rect of passes) found.push(...(await detectIn(rect)));
  const boxes = mergeBoxes(found, { limit: maxPlates });
  const detectorMs = Date.now() - detectorStarted;

  const ocrStarted = Date.now();
  const plates = [];
  for (const box of boxes) {
    const width = Math.max(1, box.x2 - box.x1);
    const height = Math.max(1, box.y2 - box.y1);
    const crop = await sharp(decoded.data, {
      raw: { width: frame.width, height: frame.height, channels: 3 },
    })
      .extract({ left: box.x1, top: box.y1, width, height })
      .resize({
        width: config.width,
        height: config.height,
        kernel: 'linear',
        fit: 'fill',
      })
      .toColourspace(config.colorMode === 'rgb' ? 'srgb' : 'b-w')
      .raw()
      .toBuffer();
    const channels = config.colorMode === 'rgb' ? 3 : 1;
    const output = await ocr.run({
      [ocr.inputNames[0]]: new ort.Tensor('uint8', new Uint8Array(crop), [
        1,
        config.height,
        config.width,
        channels,
      ]),
    });
    const plateOutput = output[ocr.outputNames[0]] ?? output.plate;
    if (!plateOutput) continue;
    const plate = decodePlate(
      { data: plateOutput.data, dims: plateOutput.dims },
      config,
    );
    if (!plate) continue;
    if (plate.confidence < ALPR_MIN_PLATE_CONFIDENCE) continue;
    if (!looksLikePlate(plate.text)) continue;
    plates.push({
      text: plate.text,
      confidence: Number(plate.confidence.toFixed(4)),
      box: { x1: box.x1, y1: box.y1, x2: box.x2, y2: box.y2 },
      boxScore: Number(box.score.toFixed(4)),
    });
  }
  const ocrMs = Date.now() - ocrStarted;

  return {
    plates,
    frame,
    model: {
      detector: 'yolo-v9-t-384-license-plates-end2end',
      ocr: 'cct-xs-v2-global',
      input: ALPR_DETECTOR_SIZE,
    },
    // How many detector runs this answer cost: one, or one per tile plus the
    // whole-frame pass. Diagnostic only; the route does not forward it.
    passes: passes.length,
    ms: {
      decode: decodeMs,
      detector: detectorMs,
      ocr: ocrMs,
      total: Date.now() - started,
    },
  };
}
