#!/usr/bin/env node
/**
 * keyed-live-layers-workflow.mjs — generate the keyed provider wiring in
 * .github/workflows/live-layers.yml from the canary's KEYED_LAYERS manifest.
 *
 * GitHub Actions cannot read a secret list at runtime: a step's `env:` mapping
 * is static YAML, and so is the shell that names each layer. Keeping that list
 * beside KEYED_LAYERS meant four edits per new provider (detection env, its
 * select line, the keyed preview env, and the manifest) and one of them was
 * easy to miss — the canary then silently skipped a layer.
 *
 * This module owns exactly two regions, delimited by marker comments:
 *
 *   keyed-detection     the detection step's `env:` mapping and `run:` script
 *   keyed-preview-env   the keyed preview's `env:` mapping
 *
 * The keyless preview is outside both regions and must stay secret-free, so
 * generating the keyed wiring cannot leak a provider credential into the gate
 * that is supposed to run without one.
 *
 * Usage:
 *   node scripts/keyed-live-layers-workflow.mjs --check  # drift gate (default)
 *   node scripts/keyed-live-layers-workflow.mjs --write  # regenerate in place
 *
 * Exit codes: 0 current/written · 1 drift, a missing marker or an unsafe
 * manifest that cannot be rendered into the workflow.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KEYED_LAYERS } from './live-layer-manifests.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WORKFLOW_PATH = resolve(
  HERE,
  '../.github/workflows/live-layers.yml',
);

export const REGIONS = Object.freeze({
  detection: 'keyed-detection',
  previewEnv: 'keyed-preview-env',
});

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Reject a manifest that cannot be interpolated into YAML and shell verbatim.
 * A layer id reaches `add <id>;` and an env name reaches both `NAME: ${{ ... }}`
 * and `"${NAME:-}"`, so anything outside these shapes is a generation-time
 * error rather than a broken workflow discovered by a nightly run.
 */
export function validateKeyedWorkflowManifest(manifest = KEYED_LAYERS) {
  const errors = [];
  if (!Array.isArray(manifest) || manifest.length === 0) {
    return { ok: false, errors: ['manifest must be a non-empty array'] };
  }
  const seen = new Set();
  for (const [index, entry] of manifest.entries()) {
    const label = entry?.id || `entry ${index}`;
    if (typeof entry?.id !== 'string' || !ID_PATTERN.test(entry.id)) {
      errors.push(`${label}: id must be a shell-safe lowercase layer id`);
    } else if (seen.has(entry.id)) {
      errors.push(`${entry.id}: duplicate layer id`);
    } else {
      seen.add(entry.id);
    }
    if (!Array.isArray(entry?.env) || entry.env.length === 0) {
      errors.push(`${label}: env must be a non-empty array`);
      continue;
    }
    for (const name of entry.env) {
      if (typeof name !== 'string' || !ENV_PATTERN.test(name)) {
        errors.push(
          `${label}: env ${JSON.stringify(name)} is not a secret name`,
        );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The unique secret names the keyed canary needs, in manifest order. */
export function keyedSecretNames(manifest = KEYED_LAYERS) {
  const names = [];
  for (const entry of manifest) {
    for (const name of entry.env ?? []) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

const secretRef = (name) => `\${{ secrets.${name} }}`;

/** `if [ -n "${A:-}" ] && [ -n "${B:-}" ]; then add <id>; fi`, one per layer. */
export function renderDetectionScript(manifest = KEYED_LAYERS) {
  const lines = [];
  for (const { id, env } of manifest) {
    const guard = env.map((name) => `[ -n "\${${name}:-}" ]`).join(' && ');
    lines.push(`if ${guard}; then add ${id}; fi`);
  }
  return lines;
}

/** One `env:` mapping body line per unique secret. */
export function renderEnvMapping(manifest = KEYED_LAYERS) {
  return keyedSecretNames(manifest).map(
    (name) => `  ${name}: ${secretRef(name)}`,
  );
}

/**
 * The detection step's body: the env mapping plus the script that reduces the
 * present credentials to a comma-separated `only` list. No secret value is
 * echoed; the step output is the fixed set of layer ids.
 */
export function renderDetectionRegion(manifest = KEYED_LAYERS) {
  return [
    'env:',
    ...renderEnvMapping(manifest),
    'run: |',
    '  set -euo pipefail',
    '  only=""',
    '  add() { only="${only:+$only,}$1"; }',
    ...renderDetectionScript(manifest).map((line) => `  ${line}`),
    '  echo "only=$only" >> "$GITHUB_OUTPUT"',
    '  if [ -z "$only" ]; then',
    '    echo "::notice::No keyed provider secrets are configured; the keyed live canary is skipped."',
    '  fi',
  ];
}

/** The keyed preview step's env mapping. */
export function renderPreviewEnvRegion(manifest = KEYED_LAYERS) {
  return ['env:', ...renderEnvMapping(manifest)];
}

function regionBody(region, manifest) {
  if (region === REGIONS.detection) return renderDetectionRegion(manifest);
  if (region === REGIONS.previewEnv) return renderPreviewEnvRegion(manifest);
  throw new Error(`unknown generated region: ${region}`);
}

const beginMarker = (region) => `# BEGIN GENERATED ${region}`;
const endMarker = (region) => `# END GENERATED ${region}`;

/**
 * Replace the lines between one region's markers, preserving the marker lines
 * and their indentation. Throws when a marker is missing so a renamed step is
 * a loud failure instead of a workflow that silently stops being generated.
 */
export function replaceRegion(source, region, manifest = KEYED_LAYERS) {
  const lines = source.split('\n');
  const begin = beginMarker(region);
  const end = endMarker(region);
  const beginIndex = lines.findIndex((line) => line.trim().startsWith(begin));
  if (beginIndex < 0) {
    throw new Error(`live-layers.yml is missing the "${begin}" marker`);
  }
  const endIndex = lines.findIndex(
    (line, index) => index > beginIndex && line.trim().startsWith(end),
  );
  if (endIndex < 0) {
    throw new Error(`live-layers.yml is missing the "${end}" marker`);
  }
  const indent = lines[beginIndex].match(/^\s*/)[0];
  const body = regionBody(region, manifest).map((line) =>
    line ? `${indent}${line}` : '',
  );
  return [
    ...lines.slice(0, beginIndex + 1),
    ...body,
    ...lines.slice(endIndex),
  ].join('\n');
}

/** Return the workflow with both generated regions brought up to date. */
export function applyKeyedWorkflow(source, { manifest = KEYED_LAYERS } = {}) {
  const validation = validateKeyedWorkflowManifest(manifest);
  if (!validation.ok) {
    throw new Error(
      `KEYED_LAYERS cannot be rendered into the workflow:\n- ${validation.errors.join('\n- ')}`,
    );
  }
  return Object.values(REGIONS).reduce(
    (text, region) => replaceRegion(text, region, manifest),
    source,
  );
}

/** Whether the checked-in workflow matches what KEYED_LAYERS generates. */
export function isKeyedWorkflowCurrent(source, options = {}) {
  try {
    return applyKeyedWorkflow(source, options) === source;
  } catch {
    return false;
  }
}

function main(argv = process.argv.slice(2)) {
  const check = !argv.includes('--write');
  let source;
  try {
    source = readFileSync(DEFAULT_WORKFLOW_PATH, 'utf8');
  } catch (error) {
    console.error(`live layer workflow: ${error.message}`);
    return 1;
  }

  let next;
  try {
    next = applyKeyedWorkflow(source);
  } catch (error) {
    console.error(`live layer workflow: ${error.message}`);
    return 1;
  }

  if (check) {
    if (next !== source) {
      console.error(
        'live layer workflow: the keyed wiring is stale; run "node scripts/keyed-live-layers-workflow.mjs --write" and commit the result.',
      );
      return 1;
    }
    console.log('live layer workflow: keyed wiring matches KEYED_LAYERS');
    return 0;
  }

  if (next === source) {
    console.log('live layer workflow: already current');
    return 0;
  }
  writeFileSync(DEFAULT_WORKFLOW_PATH, next);
  console.log(
    'live layer workflow: regenerated the keyed wiring from KEYED_LAYERS',
  );
  return 0;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) process.exitCode = main();
