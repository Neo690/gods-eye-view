// Every provider that can answer `no_key` must have a POWER UP registry entry.
//
// The test discovers the providers from their source, not from a hand-written
// list of responses, then checks the registry entry covers exactly the
// credential variables that provider reads. Adding a keyless provider, or a
// new no_key branch, fails here until POWER UP can configure it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  KEY_SETUP_KEYS,
  knownKeySetupEnvVars,
} from '../../src/keySetupCore.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Registry entry each provider's `no_key` answer belongs to. A route that
 * answers no_key and the panel that saves its credential live in different
 * layers, so this map is the explicit seam between them.
 */
const NO_KEY_PROVIDER_REGISTRY = Object.freeze({
  'conflicts.js': 'acled',
  'firms.js': 'firms',
  'fishingEffort.js': 'global-fishing-watch',
  'mapillary.js': 'mapillary',
  'n2yo.js': 'n2yo',
  'spacetrack.js': 'space-track',
  'traffic.js': 'tomtom',
});

/** Env vars a provider reads for reasons other than a missing credential. */
const NON_KEY_ENV_VARS = new Set(['TOMTOM_DAILY_TILE_BUDGET']);

/**
 * Providers whose credential read lives in an imported module. Scanning these
 * sources too keeps the env-var check honest without hard-coding the value.
 */
const CREDENTIAL_SOURCES = Object.freeze({
  'mapillary.js': ['mapillary/tiles.js'],
});

const NO_KEY_RESPONSE =
  /\b(?:sendJson|json|conflictsFailure)\([\s\S]{0,200}?['"]no_key['"]/;
const ENV_VAR =
  /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g;

function read(relative) {
  return readFileSync(path.join(HERE, relative), 'utf8');
}

function providerFiles(directory = HERE) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...providerFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path.relative(HERE, absolute).split(path.sep).join('/'));
    }
  }
  return files.sort();
}

function envVarsIn(source) {
  const names = new Set();
  for (const match of source.matchAll(ENV_VAR)) {
    names.add(match[1] || match[2]);
  }
  return names;
}

test('every provider that answers no_key has a POWER UP registry entry', () => {
  const answering = providerFiles().filter((file) =>
    NO_KEY_RESPONSE.test(read(file)),
  );
  assert.deepEqual(
    answering,
    Object.keys(NO_KEY_PROVIDER_REGISTRY).sort(),
    'a provider with no_key was added or removed without updating the registry map',
  );
});

test('each no_key provider maps to a visible entry with exactly its credential vars', () => {
  const known = knownKeySetupEnvVars();
  for (const [file, id] of Object.entries(NO_KEY_PROVIDER_REGISTRY)) {
    const entry = KEY_SETUP_KEYS.find((candidate) => candidate.id === id);
    assert.ok(entry, `${file} maps to unknown registry id ${id}`);
    assert.ok(!entry.hidden, `${file} maps to a hidden entry`);

    const sources = [file, ...(CREDENTIAL_SOURCES[file] || [])];
    const names = new Set(
      sources.flatMap((source) => [...envVarsIn(read(source))]),
    );
    for (const name of NON_KEY_ENV_VARS) names.delete(name);

    assert.deepEqual(
      [...names].sort(),
      [...entry.envVars].sort(),
      `${file} and registry entry ${id} disagree about the credential variables`,
    );
    for (const name of entry.envVars) {
      assert.ok(
        known.has(name),
        `${id} env var ${name} is not writable by POWER UP`,
      );
    }
  }
});
