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
import { LETTERBOX_FILL, decodeDetections, letterboxPose } from './detector.js';
import { decodePlate, parsePlateConfig } from './ocr.js';

/** Longest side accepted, in pixels: a CCTV frame is never bigger than this. */
export const ALPR_MAX_PIXELS = 4096 * 4096;

/** Plates read per frame; a wide shot of a car park is not the target case. */
export const ALPR_MAX_PLATES = 6;

/** Detector floor. The model's own default is 0.25; a camera frame is noisier. */
export const ALPR_DETECT_THRESHOLD = 0.4;

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
  const options = { executionProviders: ['cpu'] };
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
 * @param {string} text Decoded OCR text.
 * @returns {boolean} True when the text could be a plate.
 */
export function looksLikePlate(text) {
  return typeof text === 'string' && /\d/.test(text) && /[A-Z]/.test(text);
}

/**
 * Read every plate in one image.
 *
 * @param {Buffer|Uint8Array} image Encoded JPEG/PNG/WebP bytes.
 * @param {{directory?:string, maxPlates?:number, threshold?:number}} [options]
 * @returns {Promise<{plates:Array<{text:string, confidence:number,
 *   box:{x1:number,y1:number,x2:number,y2:number}, boxScore:number}>,
 *   frame:{width:number,height:number}, model:object,
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

  // Letterbox to the detector's square input, exactly as open-image-models
  // does: bilinear resize, then pad with 114.
  const pose = letterboxPose(frame.width, frame.height, ALPR_DETECTOR_SIZE);
  const resized = await sharp(decoded.data, {
    raw: { width: frame.width, height: frame.height, channels: 3 },
  })
    .resize({
      width: pose.scaledWidth,
      height: pose.scaledHeight,
      kernel: 'linear',
      fit: 'fill',
    })
    .raw()
    .toBuffer();
  const size = pose.size;
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

  const detectorStarted = Date.now();
  const detectorOutput = await detector.run({
    [detector.inputNames[0]]: new ort.Tensor('float32', tensor, [
      1,
      3,
      size,
      size,
    ]),
  });
  const rawDetections =
    detectorOutput[detector.outputNames[0]] ?? detectorOutput.output0;
  const boxes = decodeDetections(
    { data: rawDetections.data, dims: rawDetections.dims },
    pose,
    frame,
    { threshold, limit: maxPlates },
  );
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
      input: size,
    },
    ms: {
      decode: decodeMs,
      detector: detectorMs,
      ocr: ocrMs,
      total: Date.now() - started,
    },
  };
}
