import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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

/** Every file under `dir`, as relative POSIX paths, in stable order. */
function walkFiles(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      files.push(...walkFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

/**
 * What `BundleAssets.response(for:)` does with a request path, minus the bytes:
 * `/` and a trailing slash mean `index.html`, the leading slash is dropped, and
 * anything that climbs back out of the bundle is refused rather than normalised.
 */
function resolveStagedRequest(www, requestPath) {
  let pathname = decodeURIComponent(requestPath.split('?')[0].split('#')[0]);
  if (!pathname || pathname === '/') pathname = '/index.html';
  if (pathname.endsWith('/')) pathname += 'index.html';
  const relative = pathname.replace(/^\/+/, '');
  if (relative.split('/').includes('..')) return { status: 400, relative };
  const found = existsSync(path.join(www, relative));
  return { status: found ? 200 : 404, relative };
}

// A build shaped like the real one: absolute asset paths, a Cesium tree with
// Workers beside it, and enough nesting that a flattened copy would show up.
const REAL_BUILD = {
  'index.html': [
    '<script src="/cesium/Cesium.js"></script>',
    '<link rel="stylesheet" href="/cesium/Widgets/widgets.css">',
    '<script type="module" src="/assets/index-abc12345.js"></script>',
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<a href="https://example.com/docs">docs</a>',
  ].join(''),
  'assets/index-abc12345.js': 'export const a = 1;',
  'assets/lazy-deadbeef.js': 'export const b = 2;',
  'cesium/Cesium.js': '/*cesium*/',
  'cesium/Widgets/widgets.css': '.cesium{}',
  'cesium/Workers/worker-1.js': '/*worker*/',
  'models/tiles/deep/terrain.glb': 'glTF',
  'manifest.webmanifest': '{"name":"God\u0027s Eye View"}',
};

test('the staged tree is the build, file for file and byte for byte', () => {
  const root = fixture({ distFiles: REAL_BUILD });
  const www = path.join(root, 'ios', 'GodsEyeView', 'www');
  prepareIosPayload({ root, apiBase: '', log: () => {} });

  const staged = walkFiles(www).filter((file) => file !== '.gitkeep');
  assert.deepEqual(staged, walkFiles(path.join(root, 'dist')));
  for (const file of staged) {
    const from = path.join(root, 'dist', file);
    const to = path.join(www, file);
    assert.equal(statSync(to).size, statSync(from).size, `${file} size`);
    assert.equal(readFileSync(to, 'utf8'), readFileSync(from, 'utf8'), file);
  }
});

test('every reference the staged page makes resolves inside the bundle', () => {
  const root = fixture({ distFiles: REAL_BUILD });
  const www = path.join(root, 'ios', 'GodsEyeView', 'www');
  prepareIosPayload({ root, apiBase: '', log: () => {} });

  // The shell serves the bundle root, so `/` is index.html and nothing else.
  assert.deepEqual(resolveStagedRequest(www, '/'), {
    status: 200,
    relative: 'index.html',
  });

  const page = readFileSync(path.join(www, 'index.html'), 'utf8');
  const refs = [...page.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((url) => !url.startsWith('http') && !url.startsWith('data:'));
  assert.ok(refs.length >= 4, 'the fixture page should reference its assets');
  for (const ref of refs) {
    const resolved = resolveStagedRequest(www, ref);
    assert.equal(resolved.status, 200, `${ref} -> ${resolved.relative}`);
  }

  // The bundle is not reachable from outside itself, however the path is spelt.
  assert.equal(resolveStagedRequest(www, '/../BuildConfig.swift').status, 400);
  assert.equal(resolveStagedRequest(www, '/assets/../index.html').status, 400);
});
