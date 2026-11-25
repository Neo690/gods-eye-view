// The Render blueprint is the Android data server's configuration contract.
//
// README names the variables that server needs; render.yaml must declare each
// one, and every `sync: false` key must be pushed from a repository secret by
// the deploy workflow. A key added to only one of the three files is a service
// that silently stays unconfigured — ADSBX_API_KEY was named in the README but
// missing from the blueprint before this guard existed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ROOT = new URL('..', import.meta.url);
const read = (file) => readFileSync(new URL(file, ROOT), 'utf8');

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Variables the README's "Android data server" table names, in backticks. */
function readmeServerKeys() {
  const text = read('README.md');
  const heading = text.indexOf(
    'The keys the Android data server needs (Render)',
  );
  assert.notEqual(heading, -1, 'README lost the Render server-key section');
  const end = text.indexOf('Already declared there', heading);
  assert.notEqual(end, -1, 'README lost the rendered-key list');
  const names = new Set();
  for (const line of text.slice(heading, end).split('\n')) {
    if (!line.startsWith('|')) continue;
    for (const match of line.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) {
      if (ENV_NAME.test(match[1])) names.add(match[1]);
    }
  }
  return [...names].sort();
}

/** Every `- key:` in render.yaml, with whether it is synced or a literal. */
function renderKeys() {
  const text = read('render.yaml');
  const keys = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const declared = line.match(/^\s*-\s+key:\s*([A-Z][A-Z0-9_]*)\s*$/);
    if (declared) {
      current = declared[1];
      keys.set(current, { sync: false, literal: false });
      continue;
    }
    if (!current) continue;
    if (/^\s+sync:\s*false\s*$/.test(line)) keys.get(current).sync = true;
    if (/^\s+value:/.test(line)) keys.get(current).literal = true;
  }
  return keys;
}

/** Secret environment entries and sync_key calls in the Render deploy job. */
function workflowSync() {
  const text = read('.github/workflows/render-deploy.yml');
  const secrets = new Set();
  for (const match of text.matchAll(
    /^\s*([A-Z][A-Z0-9_]*):\s*\$\{\{\s*secrets\.\1\s*\}\}\s*$/gm,
  )) {
    secrets.add(match[1]);
  }
  const synced = new Set();
  for (const match of text.matchAll(/^\s*sync_key\s+([A-Z][A-Z0-9_]*)/gm)) {
    synced.add(match[1]);
  }
  return { secrets, synced };
}

test('every server key named by the README is declared in render.yaml', () => {
  const declared = renderKeys();
  const missing = readmeServerKeys().filter((name) => !declared.has(name));
  assert.deepEqual(
    missing,
    [],
    `README keys missing from render.yaml: ${missing.join(', ')}`,
  );
});

test('every render sync key is pushed by the deploy workflow from its secret', () => {
  const keys = renderKeys();
  const { secrets, synced } = workflowSync();
  const syncKeys = [...keys]
    .filter(([, spec]) => spec.sync)
    .map(([name]) => name);
  assert.ok(syncKeys.length > 0, 'render.yaml has no sync:false keys');
  assert.deepEqual(
    syncKeys.filter((name) => !secrets.has(name)),
    [],
    'sync:false keys with no secrets.NAME environment line',
  );
  assert.deepEqual(
    syncKeys.filter((name) => !synced.has(name)),
    [],
    'sync:false keys with no sync_key call',
  );
  assert.deepEqual(
    [...synced].filter((name) => !keys.has(name)),
    [],
    'sync_key calls for keys absent from render.yaml',
  );
});

test('a render key is either synced or carries a literal value', () => {
  const invalid = [...renderKeys()]
    .filter(([, spec]) => !spec.sync && !spec.literal)
    .map(([name]) => name);
  assert.deepEqual(
    invalid,
    [],
    `render keys that are neither sync:false nor value: ${invalid.join(', ')}`,
  );
});
