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
 *     ones (an unfiltered run keeps its historic "whatever has a credential"),
 *     plus the layers that could not run and why — a half-configured credential
 *     pair is the case worth a warning, because it looks configured, while an
 *     absent one is the normal state of a fork and only matters when a filter
 *     asked for that layer;
 *   - the layer list a non-nightly schedule runs;
 *   - the concurrency key, which cannot read a step output.
 *
 * `--present` takes secret *names*, never values: the detection step reports
 * which of the manifest's env vars are set and this module decides what that
 * means. Keeping the mapping here means a partial credential is reported by a
 * tested function rather than by generated shell.
 *
 * The manifests are a dependency-free module for exactly that reason: this must
 * run before `npm ci`, so it must not import the gate runner (and Puppeteer).
 *
 * Usage:
 *   node scripts/live-layer-selection.mjs --layers ais-live-vessels \
 *     --present AISSTREAM_API_KEY,TOMTOM_API_KEY
 *   node scripts/live-layer-selection.mjs --schedule '<a cron in SCHEDULED_LAYERS>'
 *
 * Prints GitHub step outputs:
 *   filtered=true|false     a filter was given (a dispatch layer list or a cron)
 *   source=dispatch|schedule|full
 *   keyless=<comma list>    keyless layers to run; empty means "no --only"
 *   only=<comma list>       keyed layers to run; empty skips the keyed gate
 *   group=<key>             concurrency key, `full` when unfiltered
 *   skipped=[{id,reason}]   the keyed layers this run cannot exercise, one line
 *                           JSON: the requested ones a filter cannot run, plus
 *                           any half-configured pair on a full run
 *
 * Exit codes: 0 a usable selection · 1 an unknown id or a missing credential on
 * a manual dispatch (a scheduled run skips that layer instead of failing).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KEYED_LAYERS, KEYLESS_LAYERS } from './live-layer-manifests.mjs';

const KEYED_IDS = new Set(KEYED_LAYERS.map(({ id }) => id));
const KEYLESS_IDS = new Set(KEYLESS_LAYERS.map(({ id }) => id));

/**
 * Crons that are not the nightly, mapped to the layers they run. The AIS feed is
 * the only keyed layer with no keyless fallback, so it is the one whose
 * credential can rot silently between nightly runs; its socket is also the
 * cheapest keyed gate to drive. A six-hourly single-layer run keeps that feed
 * honest for a fraction of the nightly's browser cost.
 */
export const SCHEDULED_LAYERS = Object.freeze({
  '17 */6 * * *': Object.freeze(['ais-live-vessels']),
});

/** The layers a non-nightly cron runs; empty for the nightly and for anything else. */
export function scheduledLayers(cron) {
  const key = String(cron ?? '').trim();
  return [...(SCHEDULED_LAYERS[key] ?? [])];
}

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
 * Reduce the secret names a run was given to the keyed layers it can run.
 *
 * A layer whose env list is only half present is reported separately: the gate
 * would otherwise skip it silently, and "ACLED_EMAIL is set but ACLED_PASSWORD
 * is not" is a configuration bug someone has to see. Only names appear in the
 * reason; a value never leaves the environment.
 */
export function detectKeyedLayers(present = []) {
  const supplied = new Set(present);
  const detected = [];
  const skipped = [];
  for (const layer of KEYED_LAYERS) {
    const env = layer.env ?? [];
    const missing = env.filter((name) => !supplied.has(name));
    if (!missing.length) {
      detected.push(layer.id);
      continue;
    }
    const provided = env.filter((name) => supplied.has(name));
    skipped.push({
      id: layer.id,
      provider: layer.provider,
      partial: provided.length > 0,
      reason: provided.length
        ? `partial credential: ${provided.join(', ')} ${provided.length === 1 ? 'is' : 'are'} set but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing`
        : `no credential set (needs ${env.join(' + ')})`,
    });
  }
  return { detected, skipped };
}

/**
 * Classify the requested layers and decide what each gate runs.
 *
 * An unfiltered run runs every keyless layer and every keyed layer whose
 * credential is present, which is the canary's historic behaviour. A filtered
 * run runs exactly the requested layers; there, a requested keyed layer without
 * a credential is an error on a manual dispatch, because a green run that tested
 * something else is worse than no run at all. A scheduled filter is skipped
 * instead: a cron must not go red every six hours because an operator has not
 * added a secret yet, and the skip is reported either way.
 */
export function resolveLayerSelection({
  requested = [],
  present = [],
  schedule = '',
} = {}) {
  const scheduled = requested.length ? [] : scheduledLayers(schedule);
  const ids = requested.length ? [...requested] : scheduled;
  const source = requested.length
    ? 'dispatch'
    : scheduled.length
      ? 'schedule'
      : 'full';
  const credentials = detectKeyedLayers(present);

  const keyless = [];
  const keyed = [];
  const errors = [];

  for (const id of ids) {
    if (KEYED_IDS.has(id)) keyed.push(id);
    else if (KEYLESS_IDS.has(id)) keyless.push(id);
    else
      errors.push(
        `${id}: not a live canary layer (run "npm run qa:keyless-layers -- --list" or "npm run qa:keyed-layers -- --list" for the runnable ids)`,
      );
  }

  const filtered = source !== 'full';
  const runnable = keyed.filter((id) => credentials.detected.includes(id));
  const missing = keyed.filter((id) => !credentials.detected.includes(id));
  if (missing.length && source === 'dispatch') {
    errors.push(
      `no credential is configured for the requested keyed layer(s): ${missing.join(', ')}`,
    );
  }
  // Report only what this run was expected to exercise: the requested layers a
  // filter could not run, or — on a full run — the half-configured pairs. A
  // fork with no provider secrets would otherwise list every keyed layer in
  // every nightly summary.
  const skipped = credentials.skipped.filter((entry) =>
    filtered ? keyed.includes(entry.id) : entry.partial,
  );

  if (errors.length) {
    return {
      ok: false,
      errors,
      source,
      filtered,
      keyless: '',
      only: '',
      group: '',
      skipped,
    };
  }

  return {
    ok: true,
    errors: [],
    source,
    filtered,
    keyless: keyless.join(','),
    only: (filtered ? runnable : credentials.detected).join(','),
    group: concurrencyGroup(ids),
    skipped,
  };
}

/** The `$GITHUB_OUTPUT` body for a resolved selection. */
export function renderGithubOutput(selection) {
  return [
    `filtered=${selection.filtered ? 'true' : 'false'}`,
    `source=${selection.source ?? 'full'}`,
    `keyless=${selection.keyless}`,
    `only=${selection.only}`,
    `group=${selection.group}`,
    `skipped=${JSON.stringify(selection.skipped ?? [])}`,
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
    schedule: option(argv, '--schedule'),
    present: parseLayerFilter(option(argv, '--present')),
  });
  if (!selection.ok) {
    for (const error of selection.errors)
      console.error(`live layer filter: ${error}`);
    return 1;
  }
  // stdout is the step output, so annotations go to stderr, which Actions also
  // reads workflow commands from.
  for (const entry of selection.skipped ?? []) {
    if (!entry.partial) continue;
    console.error(
      `::warning title=Live layer ${entry.id} skipped::${entry.reason}`,
    );
  }
  if (selection.source === 'schedule' && !selection.only) {
    const ids = selection.skipped.map((entry) => entry.id).join(', ');
    console.error(
      `::notice::the scheduled keyed run has no credential for ${ids || 'its layer'}; the canary job is skipped.`,
    );
  }
  process.stdout.write(renderGithubOutput(selection));
  return 0;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) process.exitCode = main();
