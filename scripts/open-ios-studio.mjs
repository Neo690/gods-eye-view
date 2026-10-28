#!/usr/bin/env node

// Open the iOS studio, starting it first when it is not already running.
//
// This is what the desktop shortcut runs. A plain bookmark would show a dead
// page after a reboot, because the panel is a local server, not a file: so the
// launcher checks the port, starts the server detached when nothing answers,
// waits for it to be ready, and only then opens the panel.
//
// `--app` opens it as an application window instead of a browser tab: Chromium's
// app mode has no address bar, no tab strip and its own taskbar entry, and a
// private profile keeps the panel out of the everyday browsing session.
//
// Usage:  node scripts/open-ios-studio.mjs [--app]
//         IOS_STUDIO_PORT=47831 node scripts/open-ios-studio.mjs --app

import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS_DIR, '..');
const PORT = Number(process.env.IOS_STUDIO_PORT ?? 47830);
const HOST = '127.0.0.1';
const PAGE_URL = `http://${HOST}:${PORT}/`;
const AS_APP = process.argv.includes('--app');

/** Whether the panel already answers; the page is cheaper to probe than status. */
async function reachable() {
  try {
    const response = await fetch(PAGE_URL, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
}

/** The Chromium on this machine, in the order Windows machines usually have it. */
function findChromium() {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 =
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const candidates = [
    [programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'],
    [programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'],
    [programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    [programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
    [
      programFiles,
      'BraveSoftware',
      'Brave-Browser',
      'Application',
      'brave.exe',
    ],
  ].map((parts) => path.join(...parts));
  return candidates.find((candidate) => existsSync(candidate)) ?? '';
}

/**
 * Open the panel as an application window.
 *
 * The separate `--user-data-dir` is what makes it an app rather than a browser:
 * its own profile, its own icon, and no state shared with the everyday session.
 * Returns false when no Chromium is installed, so the caller can fall back.
 */
function openAppWindow() {
  const browser = findChromium();
  if (!browser) return false;
  const profile = path.join(
    process.env.LOCALAPPDATA ?? os.tmpdir(),
    'iOS studio',
    'profile',
  );
  spawn(
    browser,
    [
      `--app=${PAGE_URL}`,
      `--user-data-dir=${profile}`,
      '--window-size=1180,800',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    { detached: true, stdio: 'ignore' },
  ).unref();
  return true;
}

/** Start the server detached, keeping its output where a failure can be read. */
function startServer() {
  const logPath = path.join(os.tmpdir(), 'ios-studio.log');
  const log = openSync(logPath, 'a');
  const server = spawn(
    process.execPath,
    [path.join(SCRIPTS_DIR, 'ios-studio.mjs')],
    {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    },
  );
  server.unref();
  closeSync(log);
  return logPath;
}

async function main() {
  let logPath = '';
  if (!(await reachable())) {
    logPath = startServer();
    let up = false;
    // The status probe behind the page costs several WSL calls, so poll rather
    // than guess a fixed delay.
    for (let attempt = 0; attempt < 40 && !up; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      up = await reachable();
    }
    if (!up) {
      console.error(`ios studio did not start on ${PAGE_URL}`);
      console.error(`see ${logPath}`);
      if (process.stdout.isTTY) {
        console.error('run `npm run ios:studio` to watch it fail in place');
      }
      process.exitCode = 1;
      return;
    }
  }
  if (AS_APP && openAppWindow()) {
    console.log(`iOS studio: ${PAGE_URL} (application window)`);
    return;
  }
  if (AS_APP) {
    console.error('no Chromium found; opening a browser tab instead');
  }
  openBrowser(PAGE_URL);
  console.log(`iOS studio: ${PAGE_URL}`);
}

main();
