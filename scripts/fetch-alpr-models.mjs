#!/usr/bin/env node
/**
 * Fetch the plate-reader weights, verified against the digests in
 * `server/alpr/models.js`.
 *
 * The upstream packages download their own weights on first use with no hash
 * check, from a release tag that can be re-uploaded. A server that reads plates
 * must not inherit that, so this repository fetches once, verifies, and serves
 * from its own cache (`GEV_ALPR_MODELS_DIR` overrides the location).
 *
 *   node scripts/fetch-alpr-models.mjs            # fill the default cache
 *   node scripts/fetch-alpr-models.mjs --force    # re-download everything
 *   node scripts/fetch-alpr-models.mjs --dir /opt/alpr
 *
 * Exits non-zero on a download that does not match: an image built with this
 * script either carries the exact bytes the code pins, or does not build.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  ALPR_MODELS,
  inspectModels,
  modelsDirectory,
  sha256File,
} from '../server/alpr/models.js';

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

/** Download one model to `target`, verifying the digest before it lands. */
export async function fetchModel(key, target, { force = false, log = console.log } = {}) {
  const model = ALPR_MODELS[key];
  if (!model) throw new Error(`Unknown model: ${key}`);
  try {
    const existing = await fs.stat(target);
    if (existing.isFile() && !force) {
      const digest = await sha256File(target);
      if (digest === model.sha256) {
        log(`${key}: already present, digest matches`);
        return { key, status: 'present' };
      }
      log(`${key}: present but digest differs, replacing`);
    }
  } catch {
    // Absent: fall through to the download.
  }

  const response = await fetch(model.url, { redirect: 'follow' });
  if (!response.ok || !response.body)
    throw new Error(`${key}: HTTP ${response.status} from ${model.url}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  await pipeline(Readable.fromWeb(response.body), (await import('node:fs')).createWriteStream(partial));
  const digest = await sha256File(partial);
  if (digest !== model.sha256) {
    await fs.rm(partial, { force: true });
    throw new Error(
      `${key}: digest ${digest} does not match the pinned ${model.sha256}`,
    );
  }
  await fs.rename(partial, target);
  log(`${key}: ${model.file} verified (${model.bytes} bytes)`);
  return { key, status: 'downloaded' };
}

/** Fetch every pinned model into one directory. */
export async function fetchModels({ directory = modelsDirectory(), force = false, log = console.log } = {}) {
  for (const [key, model] of Object.entries(ALPR_MODELS))
    await fetchModel(key, path.join(directory, model.file), { force, log });
  return inspectModels(directory);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fetch-alpr-models.mjs')) {
  try {
    const { directory, force } = parseFetchArgs();
    const target = directory || modelsDirectory();
    console.log(`Fetching plate-reader models into ${target}`);
    const report = await fetchModels({ directory: target, force });
    if (!report.ok) {
      console.error('Models are incomplete:', report);
      process.exit(1);
    }
    console.log(`Ready: ${report.verified.join(', ')}`);
  } catch (error) {
    console.error(error?.message || error);
    process.exit(1);
  }
}
