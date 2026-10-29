#!/usr/bin/env node

// Recreate the iOS studio shortcut on the Windows desktop.
//
// A shortcut is machine state, not repository state: it lives on a desktop,
// names an absolute path and carries an icon, so a fresh clone — or a new
// Windows profile — has none of it, and the one that was there by hand is
// gone. This is the command that puts it back, pointing at the best thing the
// machine actually has, in the order a user would expect:
//
//   1. the installed application, wherever electron-builder put it (per-user
//      first, then all-users);
//   2. the unpacked build in `desktop/studio/release/win-unpacked`, for a
//      checkout that built the app but did not install it;
//   3. the Node launcher, `open-ios-studio.mjs --app`, when neither exists.
//
// The icon follows the same rule: an executable carries its own, so a shortcut
// to one names the executable; only the fallback needs `assets/icon.ico`,
// which is generated from the panel's favicon by `desktop/studio/build-icon.mjs`.
//
// Usage:  npm run ios:shortcut

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
// Same override as the panel server: a packaged app ships these scripts and
// drives a checkout somewhere else on disk.
const ROOT = path.resolve(
  process.env.GEV_PROJECT_ROOT?.trim() || path.join(SCRIPTS_DIR, '..'),
);
const ICON = path.join(ROOT, 'desktop', 'studio', 'assets', 'icon.ico');
const SHORTCUT_NAME = 'iOS studio.lnk';
const DESCRIPTION = 'iOS studio — build, sign and install the iOS shell';

/** Where electron-builder installs, per-user before all-users. */
export function installedExecutables(environment = process.env) {
  return [
    path.join(
      environment.LOCALAPPDATA ?? '',
      'Programs',
      'iOS studio',
      'iOS studio.exe',
    ),
    path.join(
      environment.ProgramFiles ?? 'C:\\Program Files',
      'iOS studio',
      'iOS studio.exe',
    ),
  ];
}

/**
 * What the shortcut should point at, with the icon that makes it look right.
 *
 * `exists` is injected so the choice can be tested without a machine that has
 * all three states installed at once.
 */
export function chooseShortcutTarget({
  root = ROOT,
  exists = existsSync,
  icon = ICON,
  environment = process.env,
  nodePath = process.execPath,
} = {}) {
  const installed = installedExecutables(environment).find((candidate) =>
    exists(candidate),
  );
  if (installed) {
    return {
      kind: 'installed',
      target: installed,
      args: '',
      workdir: path.dirname(installed),
      icon: `${installed},0`,
      detail: 'the installed application',
    };
  }

  const unpacked = path.join(
    root,
    'desktop',
    'studio',
    'release',
    'win-unpacked',
    'iOS studio.exe',
  );
  if (exists(unpacked)) {
    return {
      kind: 'unpacked',
      target: unpacked,
      args: '',
      workdir: path.dirname(unpacked),
      icon: `${unpacked},0`,
      detail: 'the unpacked build (npm run ios:installer --dir)',
    };
  }

  return {
    kind: 'launcher',
    target: nodePath,
    args: `"${path.join(root, 'scripts', 'open-ios-studio.mjs')}" --app`,
    workdir: root,
    icon: `${icon},0`,
    detail: 'the Node launcher, because nothing is installed or built',
  };
}

/** Single-quote a value for PowerShell, so a path cannot break the script. */
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * Write the shortcut and read it back in one call.
 *
 * `WScript.Shell` is the only supported way to create a `.lnk`, and the desktop
 * is resolved by Windows itself (it moves under OneDrive on some profiles),
 * which is why neither path is guessed here.
 */
function writeShortcut(target) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject WScript.Shell',
    "$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) " +
      psQuote(SHORTCUT_NAME),
    '$link = $shell.CreateShortcut($lnk)',
    `$link.TargetPath = ${psQuote(target.target)}`,
    `$link.Arguments = ${psQuote(target.args)}`,
    `$link.WorkingDirectory = ${psQuote(target.workdir)}`,
    `$link.IconLocation = ${psQuote(target.icon)}`,
    `$link.Description = ${psQuote(DESCRIPTION)}`,
    '$link.Save()',
    '$saved = $shell.CreateShortcut($lnk)',
    'Write-Output $lnk',
    'Write-Output $saved.TargetPath',
    'Write-Output $saved.Arguments',
    'Write-Output $saved.IconLocation',
  ].join('\n');

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not write the shortcut: ${(result.stderr ?? '').trim() || result.status}`,
    );
  }
  const [shortcutPath, savedTarget, savedArgs, savedIcon] = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim());
  return { shortcutPath, savedTarget, savedArgs, savedIcon };
}

/** Draw the icon file the fallback branch needs, when it is not there yet. */
function ensureIcon() {
  if (existsSync(ICON)) return;
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'desktop', 'studio', 'build-icon.mjs')],
    { stdio: 'inherit', windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error('could not generate desktop/studio/assets/icon.ico');
  }
}

function main() {
  if (process.platform !== 'win32') {
    console.log('desktop shortcuts are a Windows feature: nothing to do here');
    return;
  }

  const target = chooseShortcutTarget();
  console.log(`shortcut target: ${target.detail}`);
  if (target.kind === 'launcher') ensureIcon();

  const written = writeShortcut(target);
  // A `.lnk` that silently kept an old target would look like success, so the
  // values written are the values read back.
  const problems = [];
  if (written.savedTarget !== target.target) {
    problems.push(
      `target is ${written.savedTarget}, expected ${target.target}`,
    );
  }
  if (written.savedIcon !== target.icon) {
    problems.push(`icon is ${written.savedIcon}, expected ${target.icon}`);
  }
  if (problems.length > 0) {
    console.error(`shortcut: ${written.shortcutPath} is wrong`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log(`shortcut: ${written.shortcutPath}`);
  console.log(`  target: ${written.savedTarget}`);
  console.log(`  icon:   ${written.savedIcon}`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) main();
