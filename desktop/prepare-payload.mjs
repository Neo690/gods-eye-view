#!/usr/bin/env node

// Stage the checkout the installer ships in `resources/gods-eye-view`.
//
// The shell runs the app's own `vite preview` server, so the payload is the
// repository itself plus the installed dependencies — the same arrangement the
// terminal path uses. Two rules decide what is left out:
//
//   * weight that the running app never reads (VCS data, the Android shell, QA
//     output, caches);
//   * every credential file. An installer is a file people pass around, so it
//     must not be able to carry a key even by accident. Keys are entered in the
//     app's POWER UP panel after installation, exactly as in the browser.
//
// `checkParity` compares the staged tree with what the rules below should have
// copied. That check is the point of this file: an exclusion meant for the top
// level once removed `node_modules/fs-extra/lib/output`, and the installer
// looked fine until the app failed to start.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DESKTOP_DIR, '..');
const PAYLOAD_DIR = path.join(DESKTOP_DIR, '.payload', 'gods-eye-view');

// Directories skipped at the *top level of the checkout only*. Names as generic
// as `output` or `android` also occur inside dependencies, where removing them
// breaks the app.
const SKIP_TOP_LEVEL = new Set([
  '.git',
  '.github',
  '.claude',
  '.gstack',
  '.gev-cache',
  '.gev-logs',
  '.playwright-mcp',
  'qa-artifacts',
  'qa-shots',
  'screenshots',
  'output',
  'android',
  'edge-api',
  '3d-models',
  // The shell's own sources and staging area: the app never reads them, and
  // skipping them keeps the payload from containing a copy of itself.
  'desktop',
]);

// Patterns applied at any depth. Credentials are the point: an installer must
// never carry one, wherever it sits in the tree.
const SKIP_ANYWHERE = [
  /^\.env(?:\.|$)/i,
  /^pinokio\/ENVIRONMENT$/,
  /^pinokio\/\.installed$/,
  /^\.signing\//,
  /\.(?:jks|keystore|p12|pem|key|mobileprovision)$/i,
  /\.apk$/i,
  /\.log$/i,
  /(?:^|\/)\.DS_Store$/,
  /(?:^|\/)node_modules\/\.cache\//,
  /(?:^|\/)node_modules\/\.vite\//,
];

const CREDENTIAL_PATHS = [
  /^\.env(?:\.(?!example$)|$)/i,
  /^pinokio\/ENVIRONMENT$/,
  /^\.signing\//,
  /\.(?:jks|keystore|p12|pem|key)$/i,
];

function relativeTo(source, base) {
  return path.relative(base, source).split(path.sep).join('/');
}

function isAllowed(source) {
  const relative = relativeTo(source, ROOT);
  if (relative === '') return true;
  // The tracked template is not a credential and stays in the payload: it is
  // what a reader consults to know which variable names exist.
  if (relative === '.env.example') return true;
  const segments = relative.split('/');
  if (segments.length === 1 && SKIP_TOP_LEVEL.has(segments[0])) return false;
  return !SKIP_ANYWHERE.some((pattern) => pattern.test(relative));
}

function walk(dir, visit, base = dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit, base);
    else if (entry.isFile()) visit(full, relativeTo(full, base));
  }
}

function measure(dir) {
  let files = 0;
  let bytes = 0;
  walk(dir, (file) => {
    files += 1;
    bytes += statSync(file).size;
  });
  return { files, bytes };
}

// What the rules above say the payload must contain, from the source's side.
function expectedPaths() {
  const expected = new Set();
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!isAllowed(full)) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) expected.add(relativeTo(full, ROOT));
    }
  };
  visit(ROOT);
  return expected;
}

function checkParity() {
  const expected = expectedPaths();
  const missing = [];
  for (const relative of expected) {
    if (!existsSync(path.join(PAYLOAD_DIR, relative))) missing.push(relative);
  }
  if (missing.length) {
    throw new Error(
      `the payload is missing ${missing.length} expected files, starting with: ${missing
        .slice(0, 5)
        .join(', ')}`,
    );
  }
  return expected.size;
}

// A staged credential file is a release blocker, not a warning: it would be
// shipped to whoever installs the app. A link is one too: `node_modules` can
// carry a symlink whose target is the build machine's checkout, which is both a
// copy electron-builder refuses and a payload that breaks on any other PC.
function checkPayload() {
  const credentials = [];
  const links = [];
  walk(PAYLOAD_DIR, (file, relative) => {
    if (CREDENTIAL_PATHS.some((pattern) => pattern.test(relative)))
      credentials.push(relative);
    if (lstatSync(file).isSymbolicLink()) links.push(relative);
  });
  if (credentials.length) {
    throw new Error(
      `credential files would be packaged: ${credentials.join(', ')}`,
    );
  }
  if (links.length) {
    throw new Error(
      `the payload would carry symbolic links: ${links.slice(0, 5).join(', ')}`,
    );
  }
}

export function preparePayload() {
  if (!existsSync(path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'))) {
    throw new Error(
      'node_modules/vite is missing: run `npm install` in the repository root before packaging.',
    );
  }
  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error(
      'dist/index.html is missing: run `npm run build` before packaging.',
    );
  }

  rmSync(path.join(DESKTOP_DIR, '.payload'), { recursive: true, force: true });
  mkdirSync(PAYLOAD_DIR, { recursive: true });
  // Top-level entries are copied one by one rather than the root as a whole:
  // the destination lives inside the checkout, and a single recursive copy
  // would refuse to write a subdirectory of its own source.
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    const source = path.join(ROOT, entry.name);
    if (!isAllowed(source)) continue;
    cpSync(source, path.join(PAYLOAD_DIR, entry.name), {
      recursive: entry.isDirectory(),
      filter: isAllowed,
      // Copy what a link points at, not the link: the payload has to stand on
      // its own once it is installed somewhere else.
      dereference: true,
    });
  }
  checkPayload();
  const expected = checkParity();

  const { files, bytes } = measure(PAYLOAD_DIR);
  console.log(
    `payload: ${files} files (${expected} expected), ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${path.relative(process.cwd(), PAYLOAD_DIR)}`,
  );
  return { files, bytes, dir: PAYLOAD_DIR };
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (invoked === import.meta.url) {
  try {
    preparePayload();
  } catch (error) {
    console.error(`payload failed: ${error.message}`);
    process.exitCode = 1;
  }
}
