#!/usr/bin/env node
/**
 * live-layer-selection.mjs — decide what a canary run should actually do.
 *
 * The canary runs two previews: one without provider secrets (keyless) and one
 * with them (keyed). A layer belongs to exactly one of them, so a targeted run
 * must not start the other preview or gate.
 *
 * One call resolves everything the canary job needs, in the cheap job that runs
 * before any dependency install:
 *
 *   - which gate each requested layer belongs to, or an error for an id neither
 *     gate can run;
 *   - the keyed layers whose credentials are present, narrowed to the requested
 *     ones (an unfiltered run keeps its historic "whatever has a credential");
 *   - the concurrency key, which cannot read a step output.
 *
 * The manifests are a dependency-free module for exactly that reason: this must
 * run before `npm ci`, so it must not import the gate runner (and Puppeteer).
 *
 * Usage:
 *   node scripts/live-layer-selection.mjs --layers ais-live-vessels \
 *     --detected ais-live-vessels,traffic
 *
 * Prints GitHub step outputs:
 *   filtered=true|false     a filter was given
 *   keyless=<comma list>    keyless layers to run; empty means "no --only"
 *   only=<comma list>       keyed layers to run; empty skips the keyed gate
 *   group=<key>             concurrency key, `full` when unfiltered
 *
 * Exit codes: 0 a usable selection · 1 an unknown id or a missing credential.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KEYED_LAYERS, KEYLESS_LAYERS } from './live-layer-manifests.mjs';

const KEYED_IDS = new Set(KEYED_LAYERS.map(({ id }) => id));
const KEYLESS_IDS = new Set(KEYLESS_LAYERS.map(({ id }) => id));

/**
 * Concurrency key for a resolved filter. The ids are sorted so the same set
 * requested in another order shares one group; an unfiltered run keeps the
 * `full` group so two nightly runs still cancel each other, while a filtered
 * run and the nightly never do.
 */
export function concurrencyGroup(requested = []) {
  const ids = [...new Set(requested)].sort();
  return ids.length ? `filter-${ids.join('+')}` : 'full';
}

/**
 * Split a filter into unique ids. Commas and whitespace both separate, because
 * a pasted list may carry either.
 */
export function parseLayerFilter(value) {
  const ids = String(value ?? '')
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.filter((id, index) => ids.indexOf(id) === index);
}

/**
 * Classify the requested layers and decide what each gate runs.
 *
 * An unfiltered run runs every keyless layer and every keyed layer whose
 * credential is present (`detected`), which is the canary's historic behaviour.
 * A filtered run runs exactly the requested layers; there, a requested keyed
 * layer without a credential is an error, because a green run that tested
 * something else is worse than no run at all.
 */
export function resolveLayerSelection({ requested = [], detected = [] } = {}) {
  const keyless = [];
  const keyed = [];
  const errors = [];

  for (const id of requested) {
    if (KEYED_IDS.has(id)) keyed.push(id);
    else if (KEYLESS_IDS.has(id)) keyless.push(id);
    else
      errors.push(
        `${id}: not a live canary layer (run "npm run qa:keyless-layers -- --list" or "npm run qa:keyed-layers -- --list" for the runnable ids)`,
      );
  }

  const filtered = requested.length > 0;
  const missing = filtered ? keyed.filter((id) => !detected.includes(id)) : [];
  if (missing.length) {
    errors.push(
      `no credential is configured for the requested keyed layer(s): ${missing.join(', ')}`,
    );
  }

  if (errors.length) {
    return { ok: false, errors, filtered, keyless: '', only: '', group: '' };
  }

  return {
    ok: true,
    errors: [],
    filtered,
    keyless: keyless.join(','),
    only: (filtered ? keyed : detected).join(','),
    group: concurrencyGroup(requested),
  };
}

/** The `$GITHUB_OUTPUT` body for a resolved selection. */
export function renderGithubOutput(selection) {
  return [
    `filtered=${selection.filtered ? 'true' : 'false'}`,
    `keyless=${selection.keyless}`,
    `only=${selection.only}`,
    `group=${selection.group}`,
  ]
    .join('\n')
    .concat('\n');
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? '') : '';
}

function main(argv = process.argv.slice(2)) {
  const selection = resolveLayerSelection({
    requested: parseLayerFilter(option(argv, '--layers')),
    detected: parseLayerFilter(option(argv, '--detected')),
  });
  if (!selection.ok) {
    for (const error of selection.errors)
      console.error(`live layer filter: ${error}`);
    return 1;
  }
  process.stdout.write(renderGithubOutput(selection));
  return 0;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) process.exitCode = main();
