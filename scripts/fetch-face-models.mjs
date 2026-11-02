#!/usr/bin/env node
/**
 * Fetch the face-module weights, verified against the digests in
 * `server/face/models.js`.
 *
 * InsightFace withdrew its public model downloads, so these are the exact
 * `buffalo_s v0.7` files, hosted by the Immich project and verified twice:
 * against its own copy and against a second mirror, before being pinned. The
 * server will not load weights it was never told to accept.
 *
 *   node scripts/fetch-face-models.mjs            # fill the default cache
 *   node scripts/fetch-face-models.mjs --force    # re-download everything
 *   node scripts/fetch-face-models.mjs --dir /opt/face
 *
 * Exits non-zero on a download that does not match: an image built with this
 * script either carries the exact bytes the code pins, or does not build.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

import {
  FACE_MODELS,
  inspectModels,
  modelsDirectory,
  sha256File,
} from '../server/face/models.js';

/** Read `--dir <path>` and `--force` from the command line. */
export function parseFetchArgs(argv = process.argv.slice(2)) {
  let directory = null;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') force = true;
    else if (arg === '--dir') directory = argv[(index += 1)] || null;
    else if (arg.startsWith('--dir=')) directory = arg.slice('--dir='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { directory, force };
}

/** Read exactly the byte count the model entry pinning states. */
async function download(url, target, expectedBytes) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`${url} answered ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
  const fileStat = await fs.stat(target);
  if (expectedBytes && Math.abs(fileStat.size - expectedBytes) > 1024)
    throw new Error(`${target} is ${fileStat.size} bytes, expected ~${expectedBytes}`);
}

/** Fetch and verify each model; prints one line per file, like the ALPR script. */
export async function fetchFaceModels({ directory, force } = {}) {
  const targetDir = directory || modelsDirectory();
  await fs.mkdir(targetDir, { recursive: true });
  const written = [];
  for (const [key, model] of Object.entries(FACE_MODELS)) {
    const file = path.join(targetDir, model.file);
    let present = null;
    try {
      present = await fs.stat(file);
    } catch {
      present = null;
    }
    if (present?.isFile() && !force) {
      const digest = await sha256File(file);
      if (digest === model.sha256) {
        console.log(`${file} OK`);
        written.push(key);
        continue;
      }
    }
    console.log(`fetch ${key} -> ${model.url}`);
    await download(model.url, file, model.bytes);
    const digest = await sha256File(file);
    if (digest !== model.sha256)
      throw new Error(
        `${file} hashes to ${digest}, expected ${model.sha256}`,
      );
    console.log(`${file} OK (${model.bytes} bytes)`);
    written.push(key);
  }
  const report = await inspectModels(targetDir);
  if (!report.ok)
    throw new Error(`Verification failed: ${JSON.stringify(report)}`);
  return { targetDir, written };
}

const invokedDirectly = process.argv[1]?.endsWith('fetch-face-models.mjs');
if (invokedDirectly) {
  fetchFaceModels(parseFetchArgs())
    .then(({ targetDir, written }) =>
      console.log(`\n${written.length} model(s) verified in ${targetDir}`),
    )
    .catch((error) => {
      console.error('fetch failed:', error.message);
      process.exit(1);
    });
}
