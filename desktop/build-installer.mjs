#!/usr/bin/env node

// Build the Windows installer from this checkout.
//
//   1. build the client bundle (`npm run build` in the repository root);
//   2. stage the payload the app server runs from;
//   3. package both with electron-builder.
//
// Flags: --skip-build (reuse the existing dist/), --dir (unpacked output only,
// no installer), --publish-never (default; pass --publish to override).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { preparePayload } from './prepare-payload.mjs';

const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DESKTOP_DIR, '..');
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const unpackedOnly = args.includes('--dir');
const publish = args.includes('--publish') ? 'always' : 'never';

function run(command, commandArgs, options) {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(' ')} exited with ${result.status}`,
    );
  }
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function keyState(name) {
  return process.env[name] ? 'configured' : 'none';
}

const desktopPackage = JSON.parse(
  readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8'),
);
const version =
  process.env.GEV_DESKTOP_VERSION?.trim() || desktopPackage.version;

if (!skipBuild) {
  // The client credentials are inlined into the bundle at build time, exactly
  // as the Android workflow does it: empty means the keyless Esri imagery and
  // no Google basemap, which is a supported install.
  console.log(`Cesium ion token: ${keyState('CESIUM_ION_TOKEN')}`);
  console.log(`Google Maps key: ${keyState('GOOGLE_MAPS_API_KEY')}`);
  run(npmCommand(), ['run', 'build'], { cwd: ROOT, env: process.env });
}

preparePayload();

if (!existsSync(path.join(DESKTOP_DIR, 'node_modules', 'electron-builder'))) {
  throw new Error(
    'electron-builder is not installed: run `npm install` with desktop/ as the working directory.',
  );
}

console.log(
  `packaging God's Eye View ${version}${unpackedOnly ? ' (unpacked only)' : ''}`,
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
  { cwd: DESKTOP_DIR, env: process.env },
);

console.log(
  unpackedOnly
    ? `unpacked app: ${path.join(DESKTOP_DIR, 'release', 'win-unpacked')}`
    : `installer: ${path.join(DESKTOP_DIR, 'release')}`,
);
