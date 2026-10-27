#!/usr/bin/env node
/**
 * Put this machine's provider keys into the app already installed on the phone.
 *
 * The phone keeps the keys Provider Settings saves in its own local storage: an
 * Android update preserves them, a reinstall — or "clear data" — does not. This
 * command replays them, reading a `.env` here and handing the values to the
 * app's own save route on the device (the one the panel's SAVE button posts to)
 * over the WebView's debugging socket. Nothing is baked into the APK: the
 * release is public, so an embedded key would be published, and every phone
 * would share it. No value is ever printed — the output names providers, not
 * secrets.
 *
 *   npm run apk:seed-keys                     the desktop install's own .env
 *   npm run apk:seed-keys -- --from=.env      a specific file
 *   node scripts/seed-phone-keys.mjs --serial=R58M --port=9333
 *   node scripts/seed-phone-keys.mjs --dry-run          names only, writes nothing
 *
 * The phone has to be the one adb sees, with the app running — this starts it
 * if it is not. Run `npm run apk:install` first when the build is older than
 * the checkout, and keep the phone unlocked: the socket only exists while the
 * app lives.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import {
  APK_APPLICATION_ID,
  parseArgs,
  pickDevice,
  resolveAdb,
} from './install-latest-apk.mjs';
import {
  knownKeySetupEnvVars,
  validateKeySetupUpdates,
} from '../src/keySetupCore.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The page the console runs in, as the WebView reports it to the browser. */
export const ASSET_HOST = 'appassets.androidplatform.net';

/** Where a device's WebView debugging socket is forwarded by default. */
export const DEFAULT_DEBUG_PORT = 9333;

/** The route the panel's SAVE button posts to, answered in-page by the shim. */
export const SAVE_ROUTE = '/api/setup/keys';

/** The route the panel reads its own status from. */
export const STATUS_ROUTE = '/api/setup/status';

/** How long a cold app start is given before its socket counts as missing. */
export const APP_START_TIMEOUT_MS = 30_000;

/** How long a page evaluation is given before it counts as hung. */
export const EVALUATE_TIMEOUT_MS = 30_000;

/** The flags this command documents; anything else is a typo, not a no-op. */
export const KNOWN_FLAGS = new Set([
  'from',
  'serial',
  'port',
  'adb',
  'dry-run',
  'help',
]);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The `.env` files this machine may hold the keys in, most specific first: the
 * installed desktop app's own file, which its Provider Settings writes; then
 * this checkout's; then the deploy file the hosted service is configured from.
 * @param {object} [input]
 * @param {NodeJS.Platform} [input.platform]
 * @param {Record<string, string|undefined>} [input.env]
 * @param {string} [input.root]
 * @returns {string[]}
 */
export function envCandidates({
  platform = process.platform,
  env = process.env,
  root = ROOT,
} = {}) {
  // electron-builder names the Windows install directory without the
  // apostrophe and the macOS bundle with it, so both spellings are tried.
  const products =
    platform === 'darwin'
      ? ["God's Eye View", 'Gods Eye View']
      : ['Gods Eye View', "God's Eye View"];
  const installed = [];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
    for (const product of products)
      installed.push(
        path.join(
          local,
          'Programs',
          product,
          'resources',
          'gods-eye-view',
          '.env',
        ),
      );
  } else if (platform === 'darwin') {
    for (const product of products)
      installed.push(
        path.join(
          '/Applications',
          `${product}.app`,
          'Contents',
          'Resources',
          'gods-eye-view',
          '.env',
        ),
      );
  } else {
    for (const product of products)
      installed.push(
        path.join(
          homedir(),
          '.local',
          'share',
          product,
          'resources',
          'gods-eye-view',
          '.env',
        ),
      );
  }
  return [
    ...installed,
    path.join(root, '.env'),
    path.join(root, '.env.deploy'),
  ];
}

/**
 * The keys a `.env` text holds, trimmed, with blank ones dropped: an empty
 * assignment means "not configured" everywhere else in this project, and the
 * save route deletes an entry when the value is blank.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseSeedEnv(text) {
  let parsed;
  try {
    parsed = parseEnv(String(text ?? '')) ?? {};
  } catch (error) {
    throw new Error(`unreadable .env: ${error.message}`);
  }
  const values = {};
  for (const [name, value] of Object.entries(parsed)) {
    const trimmed = String(value ?? '').trim();
    if (trimmed) values[name] = trimmed;
  }
  return values;
}

/**
 * Split a `.env`'s values into what the app's registry accepts and what it
 * would refuse as unknown. Only names the panel knows are ever sent, so a
 * server-only variable (uRADMonitor's, for one) cannot fail the whole save.
 * @param {Record<string, string>} values
 * @param {Set<string>} known
 * @returns {{updates: Record<string, string>, unknown: string[]}}
 */
export function selectSeedKeys(values, known) {
  const updates = {};
  const unknown = [];
  for (const [name, value] of Object.entries(values || {})) {
    if (known.has(name)) updates[name] = value;
    else unknown.push(name);
  }
  return { updates, unknown };
}

const statusKeys = (status) =>
  Array.isArray(status)
    ? status
    : Array.isArray(status?.keys)
      ? status.keys
      : [];

/**
 * How many providers the app reports as lit, and which ones. The app answers
 * this shape both before and after a save, so the caller can show the change
 * rather than claim it.
 * @param {unknown} status
 */
export function providerSummary(status) {
  const keys = statusKeys(status);
  return {
    lit: keys.filter((entry) => entry?.set).length,
    total: keys.length,
    on: keys.filter((entry) => entry?.set).map((entry) => entry.id),
  };
}

/** `3/11 -> 9/11` — what a save changed, in the app's own count. */
export function providerDelta(before, after) {
  const from = providerSummary(before);
  const to = providerSummary(after);
  return `${from.lit}/${from.total} -> ${to.lit}/${to.total}`;
}

/**
 * The WebView debugging socket of one process, out of `/proc/net/unix`. That
 * table lists every app on the device, so the pid is what separates this app's
 * socket from another app's.
 * @param {string} table
 * @param {number|string} pid
 * @returns {string|null}
 */
export function devtoolsSocket(table, pid) {
  const wanted = `webview_devtools_remote_${String(pid ?? '').trim()}`;
  if (!/^\d+$/.test(String(pid ?? '').trim())) return null;
  return new RegExp(`@${wanted}\\b`).test(String(table ?? '')) ? wanted : null;
}

/**
 * The expression evaluated in the page: read the panel's own status, save, and
 * return both. It calls the shim exactly as the SAVE button does, so the app
 * performs its own validation and schedules its own reload.
 * @param {Record<string, string>} updates
 * @returns {string}
 */
export function saveExpression(updates) {
  return `(async () => {
  const read = async () => {
    const response = await fetch(${JSON.stringify(STATUS_ROUTE)}, { cache: 'no-store' });
    return response.json().catch(() => null);
  };
  const before = await read();
  const response = await fetch(${JSON.stringify(SAVE_ROUTE)}, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: ${JSON.stringify(JSON.stringify(updates))},
  });
  const body = await response.json().catch(() => null);
  return JSON.stringify({ before, saved: { status: response.status, body } });
})()`;
}

/**
 * What a save answered, reduced to the fields worth reporting.
 * @param {unknown} payload Parsed evaluate result.
 */
export function saveOutcome(payload) {
  const saved = payload?.saved ?? {};
  const body = saved.body ?? null;
  if (saved.status !== 200 || !body?.ok)
    return {
      ok: false,
      reason: body?.error || `the app answered ${saved.status ?? 'nothing'}`,
    };
  return {
    ok: true,
    saved: Array.isArray(body.saved) ? [...body.saved].sort() : [],
    before: payload?.before ?? null,
    after: body.status ?? null,
  };
}

/** Usage text: a command explains itself where it is typed. */
export function usage() {
  return [
    "Replays this machine's provider keys into the app on the phone.",
    '',
    '  npm run apk:seed-keys [-- --from=<file>] [--serial=<id>] [--port=<n>] [--dry-run]',
    '',
    '  --from=<file>   .env to read; default: the installed desktop app, then',
    '                  ./.env, then ./.env.deploy',
    '  --serial=<id>   choose the device when several are attached',
    '  --port=<n>      local port for the WebView socket (default 9333)',
    '  --adb=<path>    adb binary, when it is not on PATH',
    '  --dry-run       say which names would be written, write nothing',
    '  --help          this text',
  ].join('\n');
}

/** Run adb and keep its output, so a failure can be explained. */
function runCommand(adb, args) {
  const result = spawnSync(adb, args, { encoding: 'utf8', windowsHide: true });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : ''),
  };
}

/** Open one page's debugging socket. */
function openSocket(url, Websocket = globalThis.WebSocket) {
  return new Promise((resolve, reject) => {
    const socket = new Websocket(url);
    socket.onerror = () =>
      reject(new Error('the WebView debugging socket refused the connection'));
    socket.onopen = () => resolve(socket);
  });
}

/** Evaluate one expression over an open socket, with its own deadline. */
function evaluateOver(socket, expression, timeoutMs = EVALUATE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = 1;
    const timer = setTimeout(() => {
      reject(new Error('the page did not answer in time'));
    }, timeoutMs);
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      if (message.result?.exceptionDetails)
        reject(new Error(message.result.exceptionDetails.text));
      else resolve(message.result?.result?.value);
    };
    socket.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    );
  });
}

/**
 * Attach to the console page behind a forwarded port, starting the app and
 * waiting for its socket when it is not up yet.
 * @param {object} input
 * @param {string} input.adb
 * @param {string} input.serial
 * @param {number} input.port
 * @param {(adb: string, args: string[]) => {status: number, stdout: string, stderr: string}} [input.run]
 * @param {typeof fetch} [input.fetchImpl]
 * @param {(ms: number) => Promise<void>} [input.wait]
 * @param {number} [input.startTimeoutMs]
 * @returns {Promise<{socket: WebSocket, forward: string[]}>}
 */
export async function attachToApp({
  adb,
  serial,
  port,
  run = runCommand,
  fetchImpl = globalThis.fetch,
  wait = delay,
  startTimeoutMs = APP_START_TIMEOUT_MS,
  log = console.log,
}) {
  const shell = (args) => run(adb, ['-s', serial, 'shell', ...args]);
  const appPid = () => {
    const result = shell(['pidof', APK_APPLICATION_ID]);
    const pid = String(result.stdout ?? '')
      .trim()
      .split(/\s+/)[0];
    return /^\d+$/.test(pid) ? pid : null;
  };
  let pid = appPid();
  if (!pid) {
    log(`app not running; starting ${APK_APPLICATION_ID}`);
    shell(['am', 'start', '-n', `${APK_APPLICATION_ID}/.MainActivity`]);
  }
  const deadline = Date.now() + startTimeoutMs;
  let socket = null;
  while (Date.now() < deadline) {
    pid = pid || appPid();
    if (pid) {
      const table = shell(['cat', '/proc/net/unix']);
      if (table.status === 0) socket = devtoolsSocket(table.stdout, pid);
    }
    if (socket) break;
    await wait(500);
  }
  if (!socket)
    throw new Error(
      `no WebView debugging socket for ${APK_APPLICATION_ID}; open the app on the phone and try again`,
    );
  const forward = [
    '-s',
    serial,
    'forward',
    `tcp:${port}`,
    `localabstract:${socket}`,
  ];
  const forwarded = run(adb, forward);
  if (forwarded.status !== 0)
    throw new Error(
      `could not forward the socket (${String(forwarded.stderr).trim() || 'adb refused'})`,
    );
  try {
    const page = await pageTarget({ port, fetchImpl, wait });
    const opened = await openSocket(page.webSocketDebuggerUrl);
    return { socket: opened, forward };
  } catch (error) {
    run(adb, ['-s', serial, 'forward', '--remove', `tcp:${port}`]);
    throw error;
  }
}

/** The console page among the targets a forwarded socket exposes. */
async function pageTarget({ port, fetchImpl, wait }) {
  const deadline = Date.now() + 15_000;
  let lastError = 'the socket exposed no page';
  while (Date.now() < deadline) {
    try {
      const targets = await (
        await fetchImpl(`http://127.0.0.1:${port}/json`)
      ).json();
      const page = targets.find(
        (target) =>
          target.type === 'page' && String(target.url).includes(ASSET_HOST),
      );
      if (page?.webSocketDebuggerUrl) return page;
      lastError = `the socket exposes ${targets.map((t) => t.type).join(', ') || 'nothing'}`;
    } catch (error) {
      lastError = error.message;
    }
    await wait(500);
  }
  throw new Error(`could not reach the app page (${lastError})`);
}

/**
 * Write validated keys into the app on the phone, through its own save route.
 * @param {object} input
 * @param {string} input.adb
 * @param {string} input.serial
 * @param {Record<string, string>} input.updates Validated {ENV_VAR: value} map.
 * @param {boolean} [input.dryRun] Report the names without touching a device.
 * @param {number} [input.port]
 * @param {Function} [input.run]
 * @param {Function} [input.fetchImpl]
 * @param {(ms: number) => Promise<void>} [input.wait]
 * @param {(line: string) => void} [input.log]
 */
export async function seedPhoneKeys({
  adb = 'adb',
  serial,
  updates,
  dryRun = false,
  port = DEFAULT_DEBUG_PORT,
  run = runCommand,
  fetchImpl = globalThis.fetch,
  wait = delay,
  log = console.log,
} = {}) {
  const names = Object.keys(updates || {}).sort();
  if (!names.length) return { ok: false, reason: 'nothing to write' };
  if (dryRun)
    return {
      ok: true,
      dryRun: true,
      names,
      reason: `would write ${names.length} key(s)`,
    };

  const { socket, forward } = await attachToApp({
    adb,
    serial,
    port,
    run,
    fetchImpl,
    wait,
    log,
  });
  try {
    const answer = await evaluateOver(socket, saveExpression(updates));
    const outcome = saveOutcome(JSON.parse(answer));
    return { ...outcome, names, port };
  } finally {
    run(adb, ['-s', serial, 'forward', '--remove', `tcp:${port}`]);
    void forward;
    try {
      socket.close();
    } catch {
      /* the page may already have reloaded */
    }
  }
}

/**
 * Read a `.env`, keep the names the app knows, and report what a save would do.
 * @param {object} input
 * @param {string} input.file
 * @param {Set<string>} [input.known]
 */
export function planSeed({ file, known = knownKeySetupEnvVars() }) {
  const text = readFileSync(file, 'utf8');
  const values = parseSeedEnv(text);
  const { updates, unknown } = selectSeedKeys(values, known);
  const validation = validateKeySetupUpdates(updates);
  return { file, values, updates, unknown, validation };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv, KNOWN_FLAGS);
  } catch (error) {
    console.error(`${error.message}\n\n${usage()}`);
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const known = knownKeySetupEnvVars();
  let file =
    typeof options.from === 'string' ? path.resolve(options.from) : null;
  if (file && !existsSync(file)) {
    console.error(`no such file: ${file}`);
    return 2;
  }
  if (!file) {
    file = envCandidates().find((candidate) => existsSync(candidate)) ?? null;
    if (!file) {
      console.error(
        `no .env found. Looked in:\n  ${envCandidates().join('\n  ')}\nPass --from=<file>.`,
      );
      return 2;
    }
  }

  let plan;
  try {
    plan = planSeed({ file, known });
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  console.log(`reading keys from ${file}`);
  if (plan.unknown.length)
    console.log(
      `ignoring ${plan.unknown.length} name(s) the app does not know: ${plan.unknown.sort().join(', ')}`,
    );
  if (!Object.keys(plan.updates).length) {
    console.error(
      `no key the app knows is set in ${file}; pass --from=<file> for another one`,
    );
    return 1;
  }
  if (!plan.validation.ok) {
    console.error(`the app would refuse this save: ${plan.validation.error}`);
    return 1;
  }
  const { updates } = plan;
  const count = Object.keys(updates).length;
  console.log(
    `${count} key(s) the app knows: ${Object.keys(updates).sort().join(', ')}`,
  );
  if (!count) {
    console.error('nothing to write');
    return 1;
  }

  const resolved = resolveAdb({
    explicit: typeof options.adb === 'string' ? options.adb : undefined,
  });
  const devices = runCommand(resolved.adb, ['devices']);
  const picked = pickDevice(devices.stdout, { serial: options.serial });
  if (picked.error) {
    console.error(picked.error);
    return 2;
  }

  try {
    const result = await seedPhoneKeys({
      adb: resolved.adb,
      serial: picked.serial,
      updates,
      dryRun: Boolean(options['dry-run']),
      port: Number(options.port) || DEFAULT_DEBUG_PORT,
    });
    if (result.dryRun) {
      console.log(result.reason);
      return 0;
    }
    if (!result.ok) {
      console.error(`the app refused the save: ${result.reason}`);
      return 1;
    }
    console.log(
      `wrote ${result.saved.length} key(s): ${result.saved.join(', ')}`,
    );
    console.log(`providers lit: ${providerDelta(result.before, result.after)}`);
    const off = providerSummary(result.after);
    console.log(
      `the app reloads itself in a moment (${off.lit}/${off.total} providers on)`,
    );
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  const code = await main();
  if (code !== 0) process.exitCode = code;
}
