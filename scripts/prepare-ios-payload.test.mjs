import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildConfigSource,
  normalizeApiBase,
  prepareIosPayload,
} from './prepare-ios-payload.mjs';

/** A throwaway checkout holding only what the staging step reads. */
function fixture({
  withDist = true,
  distFiles = {
    'index.html': '<!doctype html>',
    'assets/app.js': 'export {};',
  },
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gev-ios-'));
  mkdirSync(path.join(root, 'ios', 'GodsEyeView'), { recursive: true });
  if (withDist) {
    for (const [name, contents] of Object.entries(distFiles)) {
      const target = path.join(root, 'dist', name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents, 'utf8');
    }
  }
  return root;
}

test('an empty data server is a valid, explicit build', () => {
  assert.equal(normalizeApiBase(''), '');
  assert.equal(normalizeApiBase(undefined), '');
  assert.equal(normalizeApiBase('   '), '');
  assert.match(buildConfigSource(''), /static let apiBase = ""/);
});

test('a trailing slash does not create a second origin', () => {
  assert.equal(
    normalizeApiBase('https://gev.example.com/'),
    'https://gev.example.com',
  );
  assert.equal(
    normalizeApiBase('https://gev.example.com///'),
    'https://gev.example.com',
  );
  assert.equal(
    normalizeApiBase('https://gev.example.com'),
    'https://gev.example.com',
  );
});

test('plain HTTP is refused, because ATS allows it only for loopback', () => {
  assert.throws(
    () => normalizeApiBase('http://gev.example.com'),
    /must be https/,
  );
});

test('a path or query is refused rather than silently dropped', () => {
  assert.throws(
    () => normalizeApiBase('https://gev.example.com/api'),
    /must be an origin/,
  );
  assert.throws(
    () => normalizeApiBase('https://gev.example.com?a=1'),
    /must be an origin/,
  );
  assert.throws(() => normalizeApiBase('not a url'), /not a URL/);
});

test('staging copies the build verbatim and writes the data-server origin', () => {
  const root = fixture();
  const result = prepareIosPayload({
    root,
    apiBase: 'https://gev.example.com/',
    log: () => {},
  });
  const www = path.join(root, 'ios', 'GodsEyeView', 'www');
  assert.equal(result.files, 2);
  assert.equal(result.apiBase, 'https://gev.example.com');
  assert.equal(
    readFileSync(path.join(www, 'assets', 'app.js'), 'utf8'),
    'export {};',
  );
  const config = readFileSync(
    path.join(root, 'ios', 'GodsEyeView', 'BuildConfig.swift'),
    'utf8',
  );
  assert.match(config, /static let apiBase = "https:\/\/gev\.example\.com"/);
  assert.match(config, /enum BuildConfig/);
});

test('the tracked .gitkeep survives staging, so XcodeGen still finds the folder', () => {
  const root = fixture();
  const keep = path.join(root, 'ios', 'GodsEyeView', 'www', '.gitkeep');
  mkdirSync(path.dirname(keep), { recursive: true });
  writeFileSync(keep, '');
  prepareIosPayload({ root, apiBase: '', log: () => {} });
  assert.ok(existsSync(keep));
  assert.equal(
    existsSync(path.join(root, 'ios', 'GodsEyeView', 'www', 'index.html')),
    true,
  );
});

test('the staged copy mirrors dist/, so a removed file is really removed', () => {
  const root = fixture({
    distFiles: { 'index.html': '<!doctype html>', 'stale/old.js': '' },
  });
  prepareIosPayload({ root, apiBase: '', log: () => {} });
  const stagedStale = path.join(
    root,
    'ios',
    'GodsEyeView',
    'www',
    'stale',
    'old.js',
  );
  assert.ok(existsSync(stagedStale));

  rmSync(path.join(root, 'dist', 'stale'), { recursive: true, force: true });
  prepareIosPayload({ root, apiBase: '', log: () => {} });
  assert.equal(existsSync(stagedStale), false);
});

test('a missing build fails with the command that produces it', () => {
  const root = fixture({ withDist: false });
  assert.throws(
    () => prepareIosPayload({ root, apiBase: '', log: () => {} }),
    /run `npm run build`/,
  );
});

test('a credential-shaped file stops the build', () => {
  const root = fixture({
    distFiles: { 'index.html': '<!doctype html>', '.env.production': 'A=1' },
  });
  assert.throws(
    () => prepareIosPayload({ root, apiBase: '', log: () => {} }),
    /credential-shaped files/,
  );
});
