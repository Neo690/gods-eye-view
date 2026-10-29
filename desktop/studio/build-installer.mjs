#!/usr/bin/env node

// Build the standalone Windows app and its installer for the iOS studio panel.
//
//   1. draw the icon (build-icon.mjs): assets/icon.png and assets/icon.ico;
//   2. remember which checkout this build shipped with, so an installed copy
//      opens on it instead of asking on first run (--no-bake-root to skip);
//   3. package with electron-builder — an unpacked app with --dir, otherwise the
//      NSIS installer;
//   4. check the artifact is actually there, with its size, rather than trusting
//      a packager that can exit 0 with nothing to show.
//
// Flags: --dir (unpacked only), --no-bake-root, --skip-icon, --publish.
// Usage:  node desktop/studio/build-installer.mjs        (or `npm run ios:installer`)

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDIO_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(STUDIO_DIR, '..', '..');
const args = process.argv.slice(2);
const unpackedOnly = args.includes('--dir');
const bakeRoot = !args.includes('--no-bake-root');
const skipIcon = args.includes('--skip-icon');
const publish = args.includes('--publish') ? 'always' : 'never';

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    // `npx` is a .cmd shim on Windows and needs a shell; a full path to an
    // executable must not go through one, which would split it at the space in
    // `C:\Program Files`.
    shell: process.platform === 'win32' && !path.isAbsolute(command),
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(' ')} exited with ${result.status}`,
    );
  }
}

const studioPackage = JSON.parse(
  readFileSync(path.join(STUDIO_DIR, 'package.json'), 'utf8'),
);
const version = process.env.GEV_STUDIO_VERSION?.trim() || studioPackage.version;

/** Whether a folder is a checkout this panel can drive. */
function isProject(directory) {
  return (
    existsSync(path.join(directory, 'package.json')) &&
    existsSync(path.join(directory, 'scripts', 'ios-studio.mjs'))
  );
}

if (!existsSync(path.join(STUDIO_DIR, 'node_modules', 'electron-builder'))) {
  throw new Error(
    'electron-builder is not installed: run `npm install` with desktop/studio/ as the working directory.',
  );
}

if (!skipIcon) {
  run(process.execPath, [path.join(STUDIO_DIR, 'build-icon.mjs')], {
    cwd: STUDIO_DIR,
    shell: false,
  });
}
if (!existsSync(path.join(STUDIO_DIR, 'assets', 'icon.ico'))) {
  throw new Error('assets/icon.ico is missing: run `node build-icon.mjs`');
}

// The folder a fresh install opens on. Skipped when this checkout is not one
// (a build from a tarball), in which case the app asks on first run.
const bakedRoot = path.join(STUDIO_DIR, 'project-root.json');
if (bakeRoot && isProject(ROOT)) {
  writeFileSync(bakedRoot, `${JSON.stringify({ root: ROOT }, null, 2)}\n`);
  console.log(`project: ${ROOT}`);
} else if (existsSync(bakedRoot) && !bakeRoot) {
  // --no-bake-root must not ship the previous build's path by accident.
  writeFileSync(bakedRoot, `${JSON.stringify({ root: '' }, null, 2)}\n`);
  console.log('project: not baked (--no-bake-root)');
}

console.log(
  `packaging iOS studio ${version}${unpackedOnly ? ' (unpacked only)' : ''}`,
);
run(
  'npx',
  [
    'electron-builder',
    '--win',
    unpackedOnly ? 'dir' : 'nsis',
    '--publish',
    publish,
    '--config',
    'electron-builder.yml',
    `--config.extraMetadata.version=${version}`,
  ],
  { cwd: STUDIO_DIR, env: process.env },
);

const release = path.join(STUDIO_DIR, 'release');
const megabytes = (file) =>
  `${(statSync(file).size / 1024 / 1024).toFixed(1)} MiB`;

if (unpackedOnly) {
  const exe = path.join(release, 'win-unpacked', 'iOS studio.exe');
  if (!existsSync(exe)) throw new Error(`expected ${exe} and found nothing`);
  console.log(`unpacked app: ${exe} (${megabytes(exe)})`);
} else {
  const installer = readdirSync(release)
    .filter((name) => name.endsWith('.exe') && name.includes('Setup'))
    .map((name) => path.join(release, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!installer) throw new Error(`no installer in ${release}`);
  console.log(`installer: ${installer} (${megabytes(installer)})`);
}
