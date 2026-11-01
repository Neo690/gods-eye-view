#!/usr/bin/env node
/**
 * CDP client for the app's WebView on a USB-connected Android phone.
 *
 * The WebView publishes a `webview_devtools_remote_*` abstract unix socket;
 * this module binds it to a local port and speaks the Chrome DevTools
 * protocol over it, so a laptop script can evaluate JavaScript inside the
 * shipped app — the only faithful way to exercise layers, panels and their
 * state, because no emulator reproduces the phone's real WebView.
 *
 * Usage from a driver script (see `./drive-phone.mjs`):
 *   const { openAppSocket, evaluate } = await import('./cdp-phone.mjs');
 *   const send = await openAppSocket();
 *   const value = await evaluate('document.title');
 *
 * `ADB` picks the adb binary (defaults to the Windows toolchain path).
 */
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';

export const PORT = 9222;
export const ADB = process.env.ADB || 'C:/tools/adb/adb.exe';

/** Bind the WebView's DevTools socket to the local port; returns its name. */
export function ensureForward() {
  const found = spawnSync(ADB, ['shell', 'cat /proc/net/unix'], {
    encoding: 'utf8',
  });
  const name = (found.stdout.match(/webview_devtools_remote_\S+/) || [])[0];
  if (!name) throw new Error('no webview devtools socket on the device');
  spawnSync(ADB, ['forward', `tcp:${PORT}`, `localabstract:${name}`]);
  return name;
}

/** List the WebSocket debugger targets the WebView exposes. */
export async function listPages() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json`);
      return await response.json();
    } catch {
      /* the adb forward settles asynchronously */
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`nothing listening on 127.0.0.1:${PORT} after the adb forward`);
}

/** Open the app's page socket; other targets are devtools pages, not the app. */
export async function openAppSocket() {
  ensureForward();
  const pages = await listPages();
  const app = pages.find(
    (page) => page.type === 'page' && !page.url.startsWith('devtools://'),
  );
  if (!app) throw new Error('no app page on the webview');
  return app;
}

/**
 * Connect a DevTools socket and return `send(method, params)` plus an
 * `evaluate` that awaits the expression and unwraps its value.
 */
export function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    let nextId = 1;
    const pending = new Map();
    socket.on('error', reject);
    socket.on('open', () => {
      const send = (method, params = {}) =>
        new Promise((resolveCall, rejectCall) => {
          const id = nextId++;
          pending.set(id, { resolve: resolveCall, reject: rejectCall, method });
          socket.send(JSON.stringify({ id, method, params }));
        });
      socket.on('message', (data) => {
        const message = JSON.parse(String(data));
        if (!message.id || !pending.has(message.id)) return;
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error)
          entry.reject(
            new Error(
              `${entry.method}: ${
                message.error.message ?? JSON.stringify(message.error)
              }`,
            ),
          );
        else entry.resolve(message.result);
      });
      resolve({
        send,
        /** Evaluate an expression that may await, and return its value. */
        evaluate: async (expression) => {
          const { result, exceptionDetails } = await send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          if (exceptionDetails) {
            throw new Error(
              `evaluate failed: ${
                exceptionDetails.exception?.description || exceptionDetails.text
              }`,
            );
          }
          return result.value;
        },
      });
    });
  });
}
