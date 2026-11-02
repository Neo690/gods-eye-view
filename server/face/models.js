/**
 * The ONNX weights the face module uses, and how they are verified.
 *
 * `server/face` answers two questions: where is every person in a frame, and
 * is the one looking at the camera one of ours — ours meaning a person enrolled
 * by consent, never a global lookout. Both run on the InsightFace *buffalo_s*
 * pair: `SCRFD-500M` for detection, `w600k_mbf` (ArcFace, MobileFaceNet
 * backbone, 512-d embeddings) for matching.
 *
 * InsightFace withdrew its public model downloads; this repository pins the
 * files that upstream `buffalo_s v0.7` shipped, hosted by the Immich project
 * and mirrored a second time. The Uint bytes were cross-checked against both
 * mirrors before they were pinned: the digests in this file were read from the
 * two independent copies agreeing, then the fetch script verifies every file
 * it downloads against them again. An install that does not match answers 503,
 * the same contract the plate reader keeps (`server/alpr/models.js`).
 *
 * The files are not committed. `npm run face:models` fetches them into
 * `.gev-cache/face/<set>/` (git-ignored), verifies each digest, and prints what
 * it wrote. `GEV_FACE_MODELS_DIR` overrides the location.
 * @module server/face/models
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Bumping this moves the default directory, so a model change is a new set
 * beside the old one rather than a silent overwrite.
 */
export const FACE_MODEL_SET_VERSION = 'v1';

/** Detector input side, in pixels: a square letterbox, multiple of 32. */
export const FACE_DETECTOR_SIZE = 640;

const MIRROR =
  'https://huggingface.co/immich-app/buffalo_s/resolve/main';

/** Every file the engine loads, with the digest this repository accepts. */
export const FACE_MODELS = Object.freeze({
  detector: Object.freeze({
    file: 'scrfd-500m.onnx',
    url: `${MIRROR}/detection/model.onnx`,
    sha256: '5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a',
    bytes: 2_524_817,
    about: 'SCRFD-500M face detector, 5 landmarks (InsightFace buffalo_s)',
  }),
  recognizer: Object.freeze({
    file: 'w600k-mbf.onnx',
    url: `${MIRROR}/recognition/model.onnx`,
    sha256: '9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f',
    bytes: 13_616_099,
    about: 'ArcFace w600k_mbf 512-d embedder, 112x112 aligned input',
  }),
});

/** Model file paths inside a directory. */
export function modelPaths(directory) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(FACE_MODELS).map(([key, model]) => [
        key,
        path.join(directory, model.file),
      ]),
    ),
  );
}

/**
 * Where the weights live. `GEV_FACE_MODELS_DIR` wins so a deployment can mount
 * them read-only; otherwise the repository's own cache directory, which is
 * already ignored by git.
 */
export function modelsDirectory(env = process.env) {
  const override = String(env?.GEV_FACE_MODELS_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(process.cwd(), '.gev-cache', 'face', FACE_MODEL_SET_VERSION);
}

/** Lowercase hex SHA-256 of a file, streamed so a 14 MB model is not buffered. */
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
  for (const [key, model] of Object.entries(FACE_MODELS)) {
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
