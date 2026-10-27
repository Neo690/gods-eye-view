#!/usr/bin/env node

// Stage the web build inside the iOS shell, the way
// `android/app/src/main/assets/www` is staged for the APK.
//
// The shell is not a second implementation of the console: it is a WKWebView on
// the same `dist/` the browser, the desktop app and the APK run. Two things are
// written here and nothing else:
//
//   * `ios/GodsEyeView/www` — the build, copied verbatim as a folder reference
//     so relative asset paths survive;
//   * `ios/GodsEyeView/BuildConfig.swift` — the origin of a hosted data server.
//
// The Cesium ion token and the Google Maps key are NOT passed here. They are
// inlined by `vite build` into the bundle (`import.meta.env`), exactly as the
// Android workflow does it, so a shell only has to ship the output.
//
// The APK and the iOS app both end up in a public download, so the staged copy
// is checked for credential-shaped files: a release that carries a key by
// accident is the one failure this script exists to prevent.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS_DIR, '..');
const WWW_DIR = path.join(ROOT, 'ios', 'GodsEyeView', 'www');
const BUILD_CONFIG = path.join(ROOT, 'ios', 'GodsEyeView', 'BuildConfig.swift');

/**
 * Normalise `GEV_API_BASE` into the string that goes into Swift source.
 *
 * Empty is a valid answer: the shell then reports every live layer as
 * unavailable instead of failing obscurely. A plain-HTTP origin is refused
 * because ATS in the app allows only loopback over HTTP — a build that asked for
 * `http://…` would look configured and deliver nothing.
 */
export function normalizeApiBase(value) {
  let trimmed = String(value ?? '').trim();
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  if (trimmed === '') return '';
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`GEV_API_BASE is not a URL: ${trimmed}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(
      `GEV_API_BASE must be https (ATS allows plain HTTP only for 127.0.0.1): ${trimmed}`,
    );
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(
      `GEV_API_BASE must be an origin, with no path or query: ${trimmed}`,
    );
  }
  return `${url.origin}`;
}

/** Swift source for one build. Always rewritten, so a stale value cannot linger. */
export function buildConfigSource(apiBase) {
  const literal = JSON.stringify(apiBase);
  return `import Foundation

/// Build inputs. Written by \`scripts/prepare-ios-payload.mjs\`; the committed
/// copy is the standalone one (no data server).
///
/// The Cesium ion token and the Google Maps key are deliberately absent: Vite
/// inlines them into \`www/\` at build time, the same way the APK gets them.
enum BuildConfig {
  /// Origin of a hosted copy of this repository, e.g. \`https://gev.example.com\`.
  /// Empty means "no server": the shell answers \`/api/*\` with a JSON 503 that
  /// names the missing configuration, and every live layer reports it.
  static let apiBase = ${literal}
}
`;
}

/** Remove the contents of `dir`, keeping the directory and any `.gitkeep`. */
function clearDirectory(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === '.gitkeep') continue;
    rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.isFile()) visit(full);
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

const CREDENTIAL_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /\.(?:jks|keystore|p12|pem|key|mobileprovision)$/i,
];

function checkStaged(dir) {
  const offenders = [];
  walk(dir, (file) => {
    const relative = path.relative(dir, file).split(path.sep).join('/');
    const name = path.basename(file);
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(name)))
      offenders.push(relative);
  });
  if (offenders.length) {
    throw new Error(
      `credential-shaped files would ship inside the app: ${offenders.join(', ')}`,
    );
  }
}

/**
 * Stage the build. Throws with an actionable message rather than producing an
 * app that launches to a blank screen.
 */
export function prepareIosPayload({
  root = ROOT,
  apiBase = process.env.GEV_API_BASE,
  log = console.log,
} = {}) {
  const distDir = path.join(root, 'dist');
  const wwwDir = path.join(root, 'ios', 'GodsEyeView', 'www');
  const configFile = path.join(root, 'ios', 'GodsEyeView', 'BuildConfig.swift');

  if (!existsSync(path.join(distDir, 'index.html'))) {
    throw new Error(
      'dist/index.html is missing: run `npm run build` before packaging.',
    );
  }

  const normalized = normalizeApiBase(apiBase);
  // Emptied rather than removed: the folder itself is tracked (XcodeGen refuses
  // a folder reference to a path that does not exist), and `.gitkeep` in it must
  // survive a staging run.
  clearDirectory(wwwDir);
  mkdirSync(wwwDir, { recursive: true });
  cpSync(distDir, wwwDir, { recursive: true });
  if (!existsSync(path.join(wwwDir, 'index.html'))) {
    throw new Error(
      'the staged bundle has no index.html: the app would open a blank page.',
    );
  }
  checkStaged(wwwDir);

  writeFileSync(configFile, buildConfigSource(normalized), 'utf8');

  const { files, bytes } = measure(wwwDir);
  log(
    `ios payload: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${path.relative(process.cwd(), wwwDir)}`,
  );
  log(
    normalized
      ? `live data server: ${normalized}`
      : 'live data server: none (set GEV_API_BASE to light the live layers)',
  );
  return { files, bytes, dir: wwwDir, apiBase: normalized };
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (invoked === import.meta.url) {
  try {
    if (process.argv.includes('--clean')) {
      clearDirectory(WWW_DIR);
      writeFileSync(BUILD_CONFIG, buildConfigSource(''), 'utf8');
      console.log(
        `ios payload removed: ${path.relative(process.cwd(), WWW_DIR)}`,
      );
    } else {
      prepareIosPayload();
    }
  } catch (error) {
    console.error(`ios payload failed: ${error.message}`);
    process.exitCode = 1;
  }
}
