// A POWER UP entry is a promise: saving this variable turns a feature on.
//
// The registry can drift from the code that reads the variable and from the
// .env.example that tells an operator what to set. Both failures are silent —
// the panel accepts the value and the feature stays off — so pin both here.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { KEY_SETUP_KEYS } from './keySetupCore.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REGISTRY = resolve(ROOT, 'src/keySetupCore.mjs');
const SOURCE_ROOTS = ['src', 'server', 'android'];
const SOURCE_FILES = ['vite.config.js'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'qa-shots',
  'qa-artifacts',
]);

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(absolute));
    } else if (
      /\.(js|mjs|cjs|java)$/.test(entry.name) &&
      !/\.test\./.test(entry.name)
    ) {
      files.push(absolute);
    }
  }
  return files;
}

test('every POWER UP variable is documented and referenced outside the registry', () => {
  const files = [
    ...SOURCE_ROOTS.flatMap((root) => sourceFiles(resolve(ROOT, root))),
    ...SOURCE_FILES.map((file) => resolve(ROOT, file)),
  ].filter((file) => file !== REGISTRY);
  const blob = files.map((file) => readFileSync(file, 'utf8')).join('\n');
  const envExample = readFileSync(resolve(ROOT, '.env.example'), 'utf8');

  const owner = new Map();
  for (const entry of KEY_SETUP_KEYS) {
    for (const name of entry.envVars) {
      assert.ok(
        !owner.has(name),
        `${name} is saved by both ${owner.get(name)} and ${entry.id}`,
      );
      owner.set(name, entry.id);
      assert.ok(
        blob.includes(name),
        `${entry.id}: ${name} is not referenced by any production source`,
      );
      assert.ok(
        new RegExp(`(?:^|\\n)#?\\s*${name}=`).test(envExample),
        `${entry.id}: ${name} is missing from .env.example`,
      );
    }
  }
});
