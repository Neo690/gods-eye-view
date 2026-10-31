/**
 * The ONNX weights the plate reader uses, and how they are verified.
 *
 * The engine is a port of `fast-alpr` (MIT) to `onnxruntime-node`: the same
 * detector (`open-image-models`, YOLOv9 plate end2end) and the same OCR
 * (`fast-plate-ocr`, CCT global). Neither library ships its weights inside the
 * wheel — they download them from a GitHub release at first use, with no hash
 * check at all. That is acceptable for a notebook and not for a server, so this
 * repository pins the bytes it accepts: an install that does not match answers
 * 503 instead of reading a model that changed under it.
 *
 * The files are not committed. `npm run alpr:models` fetches them into
 * `.gev-cache/alpr/<set>/`, verifies each digest, and prints what it wrote.
 * @module server/alpr/models
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Bumping this moves the default directory, so a model change is a new set
 * beside the old one rather than a silent overwrite.
 */
export const ALPR_MODEL_SET_VERSION = 'v1';

/** Detector input side, in pixels: the "384" in the model name. */
export const ALPR_DETECTOR_SIZE = 384;

const RELEASE = 'https://github.com/ankandrew';

/** Every file the engine loads, with the digest this repository accepts. */
export const ALPR_MODELS = Object.freeze({
  detector: Object.freeze({
    file: 'yolo-v9-t-384-license-plates-end2end.onnx',
    url: `${RELEASE}/open-image-models/releases/download/assets/yolo-v9-t-384-license-plates-end2end.onnx`,
    sha256: '888397b96d761c89db40bc9c305838e8652660f5e282c2cadebbe8d2951a77a8',
    bytes: 7_771_218,
    about: 'YOLOv9-t plate detector (open-image-models, MIT)',
  }),
  ocr: Object.freeze({
    file: 'cct_xs_v2_global.onnx',
    url: `${RELEASE}/cnn-ocr-lp/releases/download/arg-plates/cct_xs_v2_global.onnx`,
    sha256: '8031afb5fdc6b4d80462c9d542f1284ebd2cfddf5dbacd62609848d7e2855f44',
    bytes: 3_344_292,
    about: 'CCT-XS global plate OCR (fast-plate-ocr, MIT)',
  }),
  ocrConfig: Object.freeze({
    file: 'cct_xs_v2_global_plate_config.yaml',
    url: `${RELEASE}/cnn-ocr-lp/releases/download/arg-plates/cct_xs_v2_global_plate_config.yaml`,
    sha256: '0335c74a305173bb6f393efed0fde03cadeaa0b649ed8e19f431016d8232d0a6',
    bytes: 1_725,
    about: 'Alphabet, slot count and input size for that OCR model',
  }),
});

/** Model file paths inside a directory. */
export function modelPaths(directory) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(ALPR_MODELS).map(([key, model]) => [
        key,
        path.join(directory, model.file),
      ]),
    ),
  );
}

/**
 * Where the weights live. `GEV_ALPR_MODELS_DIR` wins so a deployment can mount
 * them read-only; otherwise the repository's own cache directory, which is
 * already ignored by git.
 */
export function modelsDirectory(env = process.env) {
  const override = String(env?.GEV_ALPR_MODELS_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(process.cwd(), '.gev-cache', 'alpr', ALPR_MODEL_SET_VERSION);
}

/** Lowercase hex SHA-256 of a file, streamed so a 7 MB model is not buffered. */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * What is present, what is missing and what does not match its digest.
 *
 * @returns {Promise<{ok:boolean, directory:string, missing:string[],
 *   mismatched:string[], verified:string[]}>} A report, never a throw: the
 *   route turns a false `ok` into a 503 that says which step is missing.
 */
export async function inspectModels(directory = modelsDirectory()) {
  const missing = [];
  const mismatched = [];
  const verified = [];
  for (const [key, model] of Object.entries(ALPR_MODELS)) {
    const file = path.join(directory, model.file);
    let stat = null;
    try {
      stat = await fs.stat(file);
    } catch {
      missing.push(key);
      continue;
    }
    if (!stat.isFile()) {
      missing.push(key);
      continue;
    }
    const digest = await sha256File(file);
    if (digest !== model.sha256) mismatched.push(key);
    else verified.push(key);
  }
  return {
    ok: missing.length === 0 && mismatched.length === 0,
    directory,
    missing,
    mismatched,
    verified,
  };
}
