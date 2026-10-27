import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { knownKeySetupEnvVars } from '../src/keySetupCore.mjs';
import {
  ASSET_HOST,
  DEFAULT_DEBUG_PORT,
  KNOWN_FLAGS,
  devtoolsSocket,
  envCandidates,
  parseSeedEnv,
  planSeed,
  providerDelta,
  providerSummary,
  saveExpression,
  saveOutcome,
  seedPhoneKeys,
  selectSeedKeys,
  usage,
} from './seed-phone-keys.mjs';
import { parseArgs } from './install-latest-apk.mjs';

const tempEnv = (text) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-seed-keys-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, text);
  return { file, dir };
};

test('only the documented flags are accepted', () => {
  assert.deepEqual(parseArgs(['--dry-run'], KNOWN_FLAGS), { 'dry-run': true });
  assert.deepEqual(
    parseArgs(
      ['--from', '.env', '--port=9333', '--serial', 'R58M'],
      KNOWN_FLAGS,
    ),
    { from: '.env', port: '9333', serial: 'R58M' },
  );
  assert.throws(
    () => parseArgs(['--everywhere'], KNOWN_FLAGS),
    /unknown option/,
  );
});

test('the usage text lists every flag the parser takes', () => {
  const text = usage();
  for (const flag of KNOWN_FLAGS) assert.match(text, new RegExp(`--${flag}`));
});

test('the installed desktop app is looked at before the checkout', () => {
  const windows = envCandidates({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local' },
    root: 'C:\\repo',
  });
  // Windows' install directory drops the apostrophe; both spellings are tried.
  assert.equal(
    windows[0],
    path.join(
      'C:\\Users\\someone\\AppData\\Local',
      'Programs',
      'Gods Eye View',
      'resources',
      'gods-eye-view',
      '.env',
    ),
  );
  assert.equal(
    windows[1],
    path.join(
      'C:\\Users\\someone\\AppData\\Local',
      'Programs',
      "God's Eye View",
      'resources',
      'gods-eye-view',
      '.env',
    ),
  );
  assert.deepEqual(windows.slice(-2), [
    path.join('C:\\repo', '.env'),
    path.join('C:\\repo', '.env.deploy'),
  ]);
  // Normalized, so the check reads the same on a Windows host.
  const mac = envCandidates({ platform: 'darwin', env: {}, root: '/repo' });
  assert.match(
    mac[0].split(path.sep).join('/'),
    /^\/Applications\/God's Eye View\.app\/Contents\/Resources/,
  );
});

test('an .env is read as values, with comments, quotes and blanks handled', () => {
  const values = parseSeedEnv(
    [
      '# a comment',
      'export GEMINI_API_KEY="AIza-example"',
      'FIRMS_MAP_KEY=abc123',
      'EMPTY_KEY=',
      'BLANK_KEY="   "',
      "QUOTED='single'",
    ].join('\n'),
  );
  assert.deepEqual(values, {
    GEMINI_API_KEY: 'AIza-example',
    FIRMS_MAP_KEY: 'abc123',
    QUOTED: 'single',
  });
});

test('only names the app knows are sent, and the rest are named', () => {
  const known = new Set(['GEMINI_API_KEY', 'OPENSKY_CLIENT_ID']);
  const { updates, unknown } = selectSeedKeys(
    { GEMINI_API_KEY: 'x', OPENSKY_CLIENT_ID: 'y', URADMONITOR_USER_ID: 'z' },
    known,
  );
  assert.deepEqual(updates, { GEMINI_API_KEY: 'x', OPENSKY_CLIENT_ID: 'y' });
  assert.deepEqual(unknown, ['URADMONITOR_USER_ID']);
  assert.deepEqual(selectSeedKeys({}, known), { updates: {}, unknown: [] });
});

test('the save expression carries the values as JSON, whatever they contain', () => {
  const updates = { GEMINI_API_KEY: 'a"b\\c`d$e' };
  const expression = saveExpression(updates);
  assert.match(expression, /\/api\/setup\/keys/);
  assert.match(expression, /\/api\/setup\/status/);
  // The body is one JSON string literal, so no value can leave it and the
  // app receives exactly what the file held.
  assert.ok(expression.includes(JSON.stringify(JSON.stringify(updates))));
  assert.ok(!expression.includes('a"b\\c'), 'a raw value is not spliced in');
});

test('this app socket is picked out of the device-wide unix table', () => {
  const table =
    '0000000000000000: 00000002 00000000 00010000 0001 01 141162 @stetho_com.example_devtools_remote\n' +
    '0000000000000000: 00000002 00000000 00010000 0001 01 190468 @webview_devtools_remote_23753\n';
  assert.equal(devtoolsSocket(table, '23753'), 'webview_devtools_remote_23753');
  assert.equal(devtoolsSocket(table, '99999'), null);
  assert.equal(devtoolsSocket(table, ''), null);
  assert.equal(devtoolsSocket('', 23753), null);
});

test('the app page is the one the socket exposes', () => {
  assert.equal(ASSET_HOST, 'appassets.androidplatform.net');
  assert.equal(DEFAULT_DEBUG_PORT, 9333);
});

test('a save is reported from what the app answered, not assumed', () => {
  const ok = saveOutcome({
    before: {
      keys: [
        { id: 'gemini', set: false },
        { id: 'openai', set: true },
      ],
    },
    saved: {
      status: 200,
      body: {
        ok: true,
        saved: ['GEMINI_API_KEY', 'FIRMS_MAP_KEY'],
        status: {
          keys: [
            { id: 'gemini', set: true },
            { id: 'openai', set: true },
          ],
        },
      },
    },
  });
  assert.deepEqual(ok.saved, ['FIRMS_MAP_KEY', 'GEMINI_API_KEY']);
  assert.equal(providerDelta(ok.before, ok.after), '1/2 -> 2/2');
  assert.deepEqual(providerSummary(ok.after).on, ['gemini', 'openai']);

  const refused = saveOutcome({
    saved: {
      status: 400,
      body: { ok: false, error: 'GEMINI_API_KEY is empty' },
    },
  });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /is empty/);

  const silent = saveOutcome({ saved: { status: 502, body: null } });
  assert.equal(silent.ok, false);
  assert.match(silent.reason, /502/);
});

test('a plan keeps the app-known keys and refuses a value the app rejects', () => {
  const good = tempEnv(
    'GEMINI_API_KEY=AIza-example\nURADMONITOR_USER_ID=123\n',
  );
  const bad = tempEnv('GEMINI_API_KEY=has a space\n');
  try {
    const plan = planSeed({ file: good.file });
    assert.deepEqual(Object.keys(plan.updates), ['GEMINI_API_KEY']);
    assert.deepEqual(plan.unknown, ['URADMONITOR_USER_ID']);
    assert.equal(plan.validation.ok, true);
    assert.ok(knownKeySetupEnvVars().has('GEMINI_API_KEY'));

    const invalid = planSeed({ file: bad.file });
    assert.equal(invalid.validation.ok, false);
    assert.match(invalid.validation.error, /printable|space/);
  } finally {
    rmSync(good.dir, { recursive: true, force: true });
    rmSync(bad.dir, { recursive: true, force: true });
  }
});

test('--dry-run reports the names and never touches a device', async () => {
  const calls = [];
  const result = await seedPhoneKeys({
    adb: 'adb',
    serial: 'R58M',
    updates: { GEMINI_API_KEY: 'x', FIRMS_MAP_KEY: 'y' },
    dryRun: true,
    run: (...args) => {
      calls.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.names, ['FIRMS_MAP_KEY', 'GEMINI_API_KEY']);
  assert.match(result.reason, /would write 2 key/);
  assert.deepEqual(calls, []);

  const empty = await seedPhoneKeys({ updates: {}, dryRun: true });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /nothing to write/);
});
