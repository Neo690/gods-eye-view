'use strict';

// The desktop window is an ordinary browser view: everything it needs from the
// app — the built client and every /api/* provider route — comes from a
// `vite preview` child process reading the payload that ships beside the app.
// This module owns that child: finding it, starting it, waiting for the port
// and stopping it again.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_PORT = 8790;
const READY_TIMEOUT_MS = 90_000;
const POLL_MS = 400;

// `vite preview` runs the checkout's own vite.config.js, which is what mounts
// every /api/* provider route as preview middleware (see
// src/tooling/previewServing.test.mjs). `--configLoader runner` stops Vite from
// pre-bundling that config through esbuild, which fails on the .mjs files it
// imports once the payload is packaged.
const PREVIEW_ARGS = [
  'preview',
  '--host',
  '127.0.0.1',
  '--strictPort',
  '--configLoader',
  'runner',
];

const VITE_ENTRY = ['node_modules', 'vite', 'bin', 'vite.js'];

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

async function waitForPort(
  port,
  { timeoutMs = READY_TIMEOUT_MS, host = '127.0.0.1' } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port, host)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return false;
}

// Packaged, the payload sits in resources/gods-eye-view beside app.asar. Under
// `npm start` in desktop/ there is no payload: the checkout this folder lives
// in is the app, which is what makes the shell testable before packaging.
function payloadRoot({ packaged, resourcesPath, moduleDir }) {
  return packaged
    ? path.join(resourcesPath, 'gods-eye-view')
    : path.resolve(moduleDir, '..');
}

async function ensureServer({
  root,
  port = DEFAULT_PORT,
  execPath = process.execPath,
  log = () => {},
}) {
  if (await isPortOpen(port)) {
    // Another window, or a Pinokio launcher, already owns the port. Reusing it
    // is deliberate: the running server serves the same routes.
    log(
      `127.0.0.1:${port} already answers — reusing the server that is running`,
    );
    return { started: false, reused: true };
  }

  const viteEntry = path.join(root, ...VITE_ENTRY);
  if (!fs.existsSync(viteEntry)) {
    log(
      `payload incomplete: ${path.relative(root, viteEntry) || viteEntry} is missing`,
    );
    return { started: false, error: 'payload-incomplete' };
  }

  // Electron ships a Node runtime, so the installer does not need a system Node
  // install. A PATH `node` stays as the second attempt for a development
  // checkout whose Electron may be older than the Vite it runs.
  const attempts = [
    {
      label: "the application's own Node",
      file: execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
    {
      label: 'the system Node',
      file: process.platform === 'win32' ? 'node.exe' : 'node',
      env: {},
    },
  ];

  for (const attempt of attempts) {
    const child = spawn(
      attempt.file,
      [viteEntry, ...PREVIEW_ARGS, '--port', String(port)],
      {
        cwd: root,
        env: {
          ...process.env,
          ...attempt.env,
          HOST: '127.0.0.1',
          PORT: String(port),
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.on('error', (error) =>
      log(`could not start via ${attempt.label}: ${error.message}`),
    );
    // The child's own output is the useful half of a support report: it names
    // the port it bound and any provider the configuration rejected.
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => log(String(chunk).trimEnd()));
    }

    log(`starting the local server via ${attempt.label}`);
    if (await waitForPort(port)) {
      log(`server ready on http://127.0.0.1:${port}/ (via ${attempt.label})`);
      return { started: true, child };
    }
    stopServer(child);
    log(`the server did not answer on port ${port} via ${attempt.label}`);
  }

  return { started: false, error: 'no-server' };
}

function stopServer(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    child.kill();
  } catch {
    // Already gone: nothing to report.
  }
}

// One GET against the app's own server. Used by the packaged smoke test so a
// released installer can prove it serves the API without opening a window.
function probe(
  port,
  route = '/api/setup/status',
  { host = '127.0.0.1', timeoutMs = 15_000 } = {},
) {
  return new Promise((resolve) => {
    const request = http.get(
      { host, port, path: route, timeout: timeoutMs },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body,
            headers: response.headers,
          }),
        );
      },
    );
    request.on('timeout', () => {
      request.destroy();
      resolve({ status: 0, body: '', error: 'timeout' });
    });
    request.on('error', (error) =>
      resolve({ status: 0, body: '', error: error.message }),
    );
  });
}

module.exports = {
  DEFAULT_PORT,
  PREVIEW_ARGS,
  ensureServer,
  isPortOpen,
  payloadRoot,
  probe,
  stopServer,
  waitForPort,
};
