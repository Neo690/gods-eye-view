import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APK_APPLICATION_ID,
  installLatest,
  installedVersion,
  installFailureReason,
  newestRun,
  parseArgs,
  parseRepo,
  pickDevice,
  resolveAdb,
  runsUrl,
  shouldInstall,
} from './install-latest-apk.mjs';

test('only the documented flags are accepted', () => {
  assert.deepEqual(parseArgs(['--watch']), { watch: true });
  assert.deepEqual(parseArgs(['--interval=30', '--branch', 'android-shell']), {
    interval: '30',
    branch: 'android-shell',
  });
  assert.deepEqual(parseArgs(['--dry-run', '--force']), {
    'dry-run': true,
    force: true,
  });
  // A typo would otherwise be silently ignored for the whole watch loop.
  assert.throws(() => parseArgs(['--wath']), /unknown option --wath/);
});

test('the repository is read out of any remote URL', () => {
  assert.equal(parseRepo('https://github.com/Neo690/gods-eye-view.git'), 'Neo690/gods-eye-view');
  assert.equal(parseRepo('https://github.com/Neo690/gods-eye-view'), 'Neo690/gods-eye-view');
  assert.equal(parseRepo('git@github.com:Neo690/gods-eye-view.git'), 'Neo690/gods-eye-view');
  assert.equal(parseRepo('Neo690/gods-eye-view'), 'Neo690/gods-eye-view');
  assert.equal(parseRepo(''), null);
  assert.equal(parseRepo('not a url'), null);
});

test('the query asks GitHub for the newest successful build of one branch', () => {
  const url = new URL(runsUrl({ repo: 'Neo690/gods-eye-view', branch: 'android-shell' }));
  assert.equal(url.pathname, '/repos/Neo690/gods-eye-view/actions/workflows/android-apk.yml/runs');
  assert.equal(url.searchParams.get('branch'), 'android-shell');
  assert.equal(url.searchParams.get('status'), 'success');
  assert.equal(url.searchParams.get('per_page'), '1');
});

test('without a branch the newest published build is asked for across every branch', () => {
  // The release is one rolling tag: the run that wrote it last is the newest,
  // wherever it ran. Filtering on the checked-out branch hid exactly that and
  // reported "already installed" while a newer build sat published.
  const url = new URL(runsUrl({ repo: 'Neo690/gods-eye-view' }));
  assert.equal(url.searchParams.get('branch'), null);
  assert.equal(url.searchParams.has('branch'), false, 'no empty or undefined branch filter');
  assert.equal(url.searchParams.get('status'), 'success');
  assert.equal(url.searchParams.get('per_page'), '1');
});

test('a run summary carries the fields the install decision needs', () => {
  assert.equal(newestRun({ workflow_runs: [] }), null);
  assert.equal(newestRun({}), null);
  assert.equal(newestRun({ workflow_runs: [{ id: 1 }] }), null, 'no commit, nothing to install');
  assert.deepEqual(
    newestRun({
      workflow_runs: [
        {
          id: 9,
          head_sha: 'abc123',
          run_number: 12,
          html_url: 'https://github.com/o/r/actions/runs/9',
          created_at: '2026-10-24T13:38:04Z',
        },
      ],
    }),
    {
      id: 9,
      sha: 'abc123',
      runNumber: 12,
      url: 'https://github.com/o/r/actions/runs/9',
      createdAt: '2026-10-24T13:38:04Z',
    },
  );
});

test('a build already on the phone is not installed again', () => {
  assert.deepEqual(shouldInstall({ run: null }), {
    install: false,
    reason: 'no successful build yet',
  });
  assert.equal(
    shouldInstall({ run: { sha: 'abc123', runNumber: 4 }, state: { sha: 'abc123' } }).install,
    false,
  );
  assert.equal(
    shouldInstall({ run: { sha: 'def456', runNumber: 5 }, state: { sha: 'abc123' } }).install,
    true,
  );
  assert.equal(
    shouldInstall({ run: { sha: 'abc123' }, state: { sha: 'abc123' }, force: true }).install,
    true,
    '--force reinstalls the same build',
  );
});

test('--force is carried into the install decision', async () => {
  // The flag used to be parsed and then dropped on the way to shouldInstall,
  // so `--force` reported "already installed" and the phone kept the old build.
  const statePath = path.join(mkdtempSync(path.join(tmpdir(), 'gev-install-')), 'state.json');
  writeFileSync(statePath, JSON.stringify({ sha: 'abc1234def' }));
  const runs = {
    workflow_runs: [
      {
        id: 7,
        head_sha: 'abc1234def',
        run_number: 9,
        html_url: 'https://github.com/o/r/actions/runs/7',
        created_at: '2026-10-24T13:38:04Z',
      },
    ],
  };
  const attempt = async (force) => {
    const lines = [];
    const result = await installLatest({
      repo: 'o/r',
      branch: 'android-shell',
      serial: 'SERIAL',
      dryRun: true,
      force,
      statePath,
      fetchImpl: async () => new Response(JSON.stringify(runs), { status: 200 }),
      log: (line) => lines.push(line),
    });
    return { result, lines };
  };

  const quiet = await attempt(false);
  assert.equal(quiet.result.installed, false);
  assert.match(quiet.result.reason, /already installed/);
  assert.deepEqual(quiet.lines, [], 'a build already on the phone is not announced again');

  const forced = await attempt(true);
  assert.match(forced.result.reason, /dry run/);
  assert.match(forced.lines[0], /^installing build abc1234d/);
  assert.match(forced.lines.at(-1), /^would run: adb -s SERIAL install -r /);
});

test('one connected device is chosen; several are refused', () => {
  const one = 'List of devices attached\nBAY5NVVW8HMVAYFE\tdevice\n';
  assert.deepEqual(pickDevice(one), { serial: 'BAY5NVVW8HMVAYFE', error: null });

  const none = 'List of devices attached\n\n';
  assert.match(pickDevice(none).error, /no device is connected/);

  // An unauthorised phone is not a phone this script can install on.
  const unauthorised = 'List of devices attached\nXYZ\tunauthorized\n';
  assert.match(pickDevice(unauthorised).error, /no device is connected/);

  const two = 'List of devices attached\nAAA\tdevice\nBBB\tdevice\n';
  assert.match(pickDevice(two).error, /several devices/);
  assert.deepEqual(pickDevice(two, { serial: 'BBB' }), { serial: 'BBB', error: null });
  assert.match(pickDevice(two, { serial: 'CCC' }).error, /CCC is not connected/);
});

test('the version on the phone is read from dumpsys', () => {
  const text = [
    'Packages:',
    '  Package [com.godseye.view] (abc):',
    '    versionCode=1030 minSdk=24 targetSdk=36',
    '    versionName=1.0.1030',
  ].join('\n');
  assert.deepEqual(installedVersion(text), { versionName: '1.0.1030', versionCode: '1030' });
  assert.equal(installedVersion('nothing here'), null);
  assert.equal(APK_APPLICATION_ID, 'com.godseye.view');
});

test('an install failure is reported in words, not as raw adb output', () => {
  assert.match(
    installFailureReason('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package ...]'),
    /different key/,
  );
  assert.match(
    installFailureReason('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]'),
    /higher version code/,
  );
  assert.equal(installFailureReason('adb: device offline'), 'the device is not available');
  assert.equal(installFailureReason('error: closed\n'), 'error: closed');
});

test('adb is looked for in the SDK when PATH does not have it', () => {
  assert.deepEqual(resolveAdb({ explicit: 'C:/sdk/adb.exe', env: {} }).adb, 'C:/sdk/adb.exe');
  assert.equal(resolveAdb({ explicit: undefined, env: { ADB: '/opt/adb' } }).adb, '/opt/adb');
  const withSdk = resolveAdb({
    explicit: undefined,
    env: { ANDROID_HOME: 'C:/Android' },
    platform: 'win32',
    exists: (candidate) => candidate.endsWith('platform-tools\\adb.exe'),
  });
  assert.match(withSdk.adb, /platform-tools\\adb\.exe$/);
  assert.equal(
    resolveAdb({ explicit: undefined, env: {}, exists: () => false }).adb,
    'adb',
    'nothing found falls back to PATH, and the caller names what it looked for',
  );
});
