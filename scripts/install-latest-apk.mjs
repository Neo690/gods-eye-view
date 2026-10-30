#!/usr/bin/env node
/**
 * Put the APK the CI just built onto the phone that is plugged in.
 *
 * The release the phone downloads from is written by the `Android APK`
 * workflow, which signs with the repository key; the app already on the device
 * carries that same signature, so an install is an update in place — settings
 * and presets survive. A locally built debug APK can never do that, which is
 * why this script installs the *published* artifact rather than `dist/`:
 * `adb install -r` refuses a package signed by a different key.
 *
 * One pass answers "is something newer than what the phone runs?"; `--watch`
 * asks it again on an interval, which is the "every successful build lands on
 * the phone" behaviour. Nothing here talks to a build: it reads the runs API,
 * so it works from any machine with adb and never needs the signing key.
 *
 * The release is a single rolling tag that every build overwrites, so the
 * newest successful run is the one the release holds — whichever branch it was
 * built from. Following only the checked-out branch installed nothing while a
 * newer build sat published from another branch; `--branch` narrows the search
 * for the rare case of wanting one branch's build specifically.
 *
 *   npm run apk:install              install the newest successful build once
 *   npm run apk:watch                keep doing it (default: every 2 minutes)
 *   node scripts/install-latest-apk.mjs --branch=android-shell --serial=R58M
 *
 * Unauthenticated GitHub API calls are limited to 60 an hour, so the default
 * interval is two minutes; export GITHUB_TOKEN to poll faster.
 */
import { spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The workflow whose success publishes the APK. */
export const APK_WORKFLOW_FILE = 'android-apk.yml';

/** The rolling release the workflow overwrites on every build. */
export const APK_RELEASE_TAG = 'apk-latest';
export const APK_ASSET_NAME = 'gods-eye-view.apk';
export const APK_APPLICATION_ID = 'com.godseye.view';

/** Where the last installed build is remembered, so a watch loop is quiet. */
export const STATE_FILE = '.gev-apk-install.json';

/** Default poll interval: 30 requests an hour, half the anonymous limit. */
export const DEFAULT_INTERVAL_SECONDS = 120;

/**
 * Parse `[--flag[=value]] [--flag value]` into an option map. Only the flags
 * this script documents are taken: an unknown one is a typo that would
 * otherwise be silently ignored for the whole watch loop.
 * @param {string[]} argv
 * @param {Set<string>} [known]
 */
export function parseArgs(
  argv,
  known = new Set(['watch', 'force', 'dry-run', 'interval', 'branch', 'serial', 'repo', 'adb', 'help']),
) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) continue;
    const body = token.slice(2);
    const equals = body.indexOf('=');
    const name = (equals === -1 ? body : body.slice(0, equals)).trim();
    if (!known.has(name)) throw new Error(`unknown option --${name}`);
    if (equals !== -1) options[name] = body.slice(equals + 1);
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      options[name] = argv[index + 1];
      index += 1;
    } else options[name] = true;
  }
  return options;
}

/**
 * `github.com/owner/name` out of any clone URL the project's remotes use:
 * https, ssh and the bare `owner/name` form.
 * @param {string} remote
 * @returns {string|null}
 */
export function parseRepo(remote) {
  const text = String(remote || '').trim();
  if (!text) return null;
  const shorthand = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text);
  if (shorthand) return text.replace(/\.git$/, '');
  const match = text.match(/[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * Runs API URL: newest *successful* run of the APK workflow.
 *
 * No `branch` parameter when none is named, so GitHub answers across every
 * branch. That matches the release: `apk-latest` is one rolling tag, and the
 * run that wrote it last is the newest one regardless of where it ran.
 */
export function runsUrl({ repo, branch, workflow = APK_WORKFLOW_FILE }) {
  const query = new URLSearchParams({ status: 'success', per_page: '1' });
  if (branch) query.set('branch', branch);
  return `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?${query}`;
}

/**
 * The run summary this script needs, or null when the payload has no run.
 * @param {unknown} payload Parsed runs response.
 */
export function newestRun(payload) {
  const run = payload?.workflow_runs?.[0];
  if (!run?.head_sha) return null;
  return {
    id: run.id ?? null,
    sha: String(run.head_sha),
    runNumber: run.run_number ?? null,
    url: run.html_url ?? null,
    createdAt: run.created_at ?? null,
  };
}

/**
 * Whether this run still has to be installed. A build the phone already has is
 * not reinstalled — a watch loop must be silent, not reinstalling every tick.
 */
export function shouldInstall({ run, state, force = false }) {
  if (!run?.sha) return { install: false, reason: 'no successful build yet' };
  if (!force && state?.sha === run.sha)
    return { install: false, reason: `already installed (${short(run.sha)})` };
  return { install: true, reason: `build ${short(run.sha)}${run.runNumber ? ` (#${run.runNumber})` : ''}` };
}

/** One connected device: the named one, or the only one adb lists. */
export function pickDevice(output, { serial } = {}) {
  const devices = String(output || '')
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 2 && fields[1] === 'device')
    .map((fields) => fields[0]);
  if (serial) {
    if (!devices.includes(serial))
      return { serial: null, error: `device ${serial} is not connected (found: ${devices.join(', ') || 'none'})` };
    return { serial, error: null };
  }
  if (!devices.length) return { serial: null, error: 'no device is connected' };
  if (devices.length > 1)
    return {
      serial: null,
      error: `several devices are connected (${devices.join(', ')}); pass --serial to choose one`,
    };
  return { serial: devices[0], error: null };
}

/** Version of the package on the device, from `dumpsys package`. */
export function installedVersion(dumpsys) {
  const text = String(dumpsys || '');
  const versionName = text.match(/versionName=(\S+)/)?.[1] ?? null;
  const versionCode = text.match(/versionCode=(\d+)/)?.[1] ?? null;
  return versionName || versionCode ? { versionName, versionCode } : null;
}

/**
 * The adb to talk to. This machine keeps the SDK outside PATH, so a bare
 * `adb` is only the first guess: the SDK locations are tried next, and the
 * caller gets a message naming what it looked for instead of an ENOENT.
 */
export function resolveAdb({
  explicit,
  env = process.env,
  exists = (candidate) => existsSync(candidate),
  platform = process.platform,
} = {}) {
  const fromEnv = explicit || env.ADB;
  if (fromEnv) return { adb: fromEnv, looked: [fromEnv] };
  const suffix = platform === 'win32' ? '.exe' : '';
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, 'C:/Android'].filter(Boolean);
  // The SDK copies are checked first: a `platform-tools` directory is the
  // project's own install, while a bare `adb` is only a guess that the shell
  // will resolve (and the caller reports when it cannot).
  // Join with the target platform's rules, not the host's: CI runs these
  // checks on Linux while the SDK paths it resolves are Windows ones.
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const sdkCandidates = roots.map((root) =>
    join(root, 'platform-tools', `adb${suffix}`),
  );
  const found = sdkCandidates.find((candidate) => exists(candidate));
  return { adb: found || 'adb', looked: [...sdkCandidates, 'adb'] };
}

/** `install -r` refuses an unsigned or corrupted download; say so readably. */
export function installFailureReason(output) {
  const text = String(output || '');
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(text))
    return 'the APK is signed with a different key than the copy on the phone; the CI-signed build is the one this script installs';
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/.test(text))
    return 'the phone already runs a higher version code';
  if (/no devices|device offline|not found/i.test(text)) return 'the device is not available';
  return text.trim().split(/\r?\n/).filter(Boolean).pop() ?? 'unknown failure';
}

const short = (sha) => String(sha || '').slice(0, 8);

/** Run a command and keep its output, so a failure can be explained. */
function runCommand(command, args, { cwd = ROOT } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : ''),
  };
}

/**
 * Install one build. Separated from the loop so the loop only owns timing.
 * @param {object} input
 * @param {string} input.repo
 * @param {string} input.serial
 * @param {string} input.adb
 * @param {string} input.branch
 * @param {boolean} [input.dryRun]
 * @param {boolean} [input.force] Reinstall a build the state already records.
 */
export async function installLatest({
  repo,
  branch,
  serial,
  adb = 'adb',
  dryRun = false,
  force = false,
  statePath = path.join(ROOT, STATE_FILE),
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const response = await fetchImpl(runsUrl({ repo, branch }), {
    headers: {
      accept: 'application/vnd.github+json',
      ...(process.env.GITHUB_TOKEN
        ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
        : {}),
    },
  });
  if (response.status === 403 || response.status === 429)
    return { installed: false, reason: 'GitHub rate limit reached; set GITHUB_TOKEN or wait' };
  if (!response.ok)
    return { installed: false, reason: `GitHub answered ${response.status}` };
  const run = newestRun(await response.json());
  const state = readState(statePath);
  const verdict = shouldInstall({ run, state, force });
  if (!verdict.install) return { installed: false, reason: verdict.reason };
  log(`installing ${verdict.reason}`);

  const assetUrl = `https://github.com/${repo}/releases/download/${APK_RELEASE_TAG}/${APK_ASSET_NAME}`;
  const file = path.join(tmpdir(), `gev-${short(run.sha)}.apk`);
  if (!dryRun) {
    const download = await fetchImpl(assetUrl, { redirect: 'follow' });
    if (!download.ok)
      return { installed: false, reason: `download answered ${download.status}` };
    await writeFile(download, file);
  }

  if (dryRun) {
    log(`would run: ${adb} -s ${serial} install -r ${file}`);
    return { installed: false, reason: 'dry run', run };
  }

  const install = runCommand(adb, ['-s', serial, 'install', '-r', file]);
  if (install.status !== 0) {
    return {
      installed: false,
      reason: installFailureReason(`${install.stdout}\n${install.stderr}`),
      run,
    };
  }
  rmSync(file, { force: true });
  const version = installedVersion(
    runCommand(adb, ['-s', serial, 'shell', 'dumpsys', 'package', APK_APPLICATION_ID]).stdout,
  );
  writeState(statePath, {
    sha: run.sha,
    runId: run.id,
    versionName: version?.versionName ?? null,
  });
  log(`installed ${version?.versionName ?? short(run.sha)} on ${serial}`);
  return { installed: true, reason: verdict.reason, run, version };
}

/** Stream a fetch body to disk; a 22 MB APK does not belong in memory. */
async function writeFile(response, file) {
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    writeFileSync(file, buffer);
    return;
  }
  const stream = createWriteStream(file);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!stream.write(Buffer.from(value))) {
        await new Promise((resolve) => stream.once('drain', resolve));
      }
    }
  } finally {
    stream.end();
  }
  await new Promise((resolve) => stream.once('close', resolve));
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(file, state) {
  try {
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* a read-only checkout only costs the memory of the last build */
  }
}

function originRepo() {
  const result = runCommand('git', ['remote', 'get-url', 'origin']);
  return result.status === 0 ? parseRepo(result.stdout) : null;
}

const USAGE = `usage: node scripts/install-latest-apk.mjs [options]
  --watch            keep checking (default: one pass)
  --interval=<sec>   seconds between checks in watch mode (default ${DEFAULT_INTERVAL_SECONDS})
  --branch=<name>    narrow the search to one branch (default: every branch,
                     because the release holds whichever build ran last)
  --repo=<owner/name> repository to read (default: origin)
  --serial=<device>  adb device to install on (default: the only one connected)
  --adb=<path>       adb binary (default: $ADB, then "adb")
  --force            reinstall even when this build is already installed
  --dry-run          report what would be installed, download and install nothing
  --help             this text
`;

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const repo = options.repo || originRepo();
  if (!repo) {
    console.error('cannot tell which repository to read: pass --repo=owner/name');
    return 2;
  }
  const branch = typeof options.branch === 'string' ? options.branch : null;
  const { adb, looked } = resolveAdb({ explicit: options.adb });
  const interval = Math.max(15, Number(options.interval) || DEFAULT_INTERVAL_SECONDS);
  const devices = runCommand(adb, ['devices']);
  if (devices.status !== 0) {
    console.error(
      `cannot run adb "${adb}" (${installFailureReason(devices.stderr)}).\n` +
        `Looked for: ${looked.join(', ')}. Pass --adb=<path> or set ADB.`,
    );
    return 2;
  }
  const picked = pickDevice(devices.stdout, { serial: options.serial });
  if (picked.error) {
    console.error(picked.error);
    return 2;
  }

  const pass = async () => {
    const result = await installLatest({
      repo,
      branch,
      serial: picked.serial,
      adb,
      dryRun: Boolean(options['dry-run']),
      // Without this the flag parses and is then dropped, so `--force` would
      // report "already installed" forever — which is what it used to do.
      force: Boolean(options.force),
    });
    console.log(result.installed ? `ok: ${result.reason}` : result.reason);
    return result;
  };

  if (!options.watch) return (await pass()).installed || options['dry-run'] ? 0 : 1;

  console.log(
    `watching ${repo}${branch ? ` ${branch}` : ' (all branches)'} every ${interval}s for ${picked.serial}`,
  );
  let running = true;
  process.on('SIGINT', () => {
    running = false;
    console.log('\nstopped');
  });
  while (running) {
    try {
      await pass();
    } catch (error) {
      console.error(`pass failed: ${error.message}`);
    }
    for (let waited = 0; running && waited < interval; waited += 1)
      await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
