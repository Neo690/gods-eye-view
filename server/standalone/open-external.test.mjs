import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { browserLaunchPlan, openUrlInBrowser } from './open-external.mjs';

const WINDOWS = {
  platform: 'win32',
  environment: {
    LOCALAPPDATA: 'C:\\Users\\ghost\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  },
};
const braveOnWindows =
  'C:\\Users\\ghost\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

/** A launch that only reports the files the test says exist. */
function fileSystem(...existing) {
  return { existsSync: (file) => existing.includes(file) };
}

/** A child that reports `outcome` ('spawn' or 'error') on the next tick. */
function child(outcome, seen) {
  const fake = new EventEmitter();
  fake.unref = () => {};
  queueMicrotask(() => fake.emit(outcome));
  if (seen) seen.push(fake);
  return fake;
}

test('Windows prefers the installed Brave and falls back to the default browser', () => {
  const plan = browserLaunchPlan('https://example.test/key', {
    ...WINDOWS,
    fileSystem: fileSystem(braveOnWindows),
  });
  assert.equal(plan[0].kind, 'brave');
  assert.equal(plan[0].command, braveOnWindows);
  assert.deepEqual(plan[0].args, ['https://example.test/key']);
  // Never by bare name: a shadowing brave.exe elsewhere on PATH must not win.
  assert.equal(
    plan.some((step) => step.command === 'brave.exe'),
    false,
  );
  const fallback = plan.at(-1);
  assert.equal(fallback.kind, 'default');
  assert.equal(fallback.command, 'C:\\Windows\\explorer.exe');
  // A Windows root the environment actually names is the one used.
  assert.equal(
    browserLaunchPlan('https://example.test/key', {
      ...WINDOWS,
      environment: { ...WINDOWS.environment, SystemRoot: 'D:\\WINDOWS' },
      fileSystem: fileSystem(braveOnWindows),
    }).at(-1).command,
    'D:\\WINDOWS\\explorer.exe',
  );

  // Brave not installed is not an error — the default browser is the answer.
  assert.deepEqual(
    browserLaunchPlan('https://example.test/key', {
      ...WINDOWS,
      fileSystem: fileSystem(),
    }).map((step) => step.kind),
    ['default'],
  );
  // Machine-wide installs are found too, and user installs win over them.
  const machineWide =
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  assert.equal(
    browserLaunchPlan('https://example.test/key', {
      ...WINDOWS,
      fileSystem: fileSystem(machineWide),
    })[0].command,
    machineWide,
  );
  assert.equal(
    browserLaunchPlan('https://example.test/key', {
      ...WINDOWS,
      fileSystem: fileSystem(braveOnWindows, machineWide),
    })[0].command,
    braveOnWindows,
  );
  // An environment that names no install root has nothing to guess at.
  assert.deepEqual(
    browserLaunchPlan('https://example.test/key', {
      platform: 'win32',
      environment: {},
      fileSystem: fileSystem(braveOnWindows),
    }).map((step) => step.kind),
    ['default'],
  );
  assert.deepEqual(
    browserLaunchPlan('', {
      ...WINDOWS,
      fileSystem: fileSystem(braveOnWindows),
    }),
    [],
    'an empty target launches nothing',
  );
  assert.deepEqual(browserLaunchPlan(undefined, { ...WINDOWS }), []);
});

test('macOS and Linux ask Brave first, then their own opener', () => {
  const target = 'https://example.test/k';
  assert.deepEqual(browserLaunchPlan(target, { platform: 'darwin' }), [
    { command: 'open', args: ['-a', 'Brave Browser', target], kind: 'brave' },
    { command: 'open', args: [target], kind: 'default' },
  ]);
  assert.deepEqual(
    browserLaunchPlan(target, { platform: 'linux' }).map(
      (step) => step.command,
    ),
    ['brave-browser', 'xdg-open'],
  );
  assert.deepEqual(
    browserLaunchPlan(target, { platform: 'freebsd' }).map(
      (step) => step.command,
    ),
    ['brave-browser', 'xdg-open'],
    'any other POSIX desktop gets the same two attempts',
  );
});

test('the first launch that starts wins, a refused one moves on, and none leaves null', async () => {
  const started = [];
  const spawnImpl = (command, args) => {
    started.push({ command, args });
    return child('spawn');
  };
  const used = await openUrlInBrowser('https://example.test/k', {
    platform: 'linux',
    spawnImpl,
  });
  assert.equal(used, 'brave');
  assert.deepEqual(
    started.map((call) => call.command),
    ['brave-browser'],
    'the default browser is not launched once Brave worked',
  );
  assert.equal(started[0].args[0], 'https://example.test/k');

  // A missing Brave is reported as an 'error' event, not a throw.
  const tried = [];
  const fallback = await openUrlInBrowser('https://example.test/k', {
    platform: 'linux',
    spawnImpl: (command) => {
      tried.push(command);
      return child(command === 'brave-browser' ? 'error' : 'spawn');
    },
  });
  assert.equal(fallback, 'default');
  assert.deepEqual(tried, ['brave-browser', 'xdg-open']);

  // A machine that cannot launch anything at all answers null so the caller
  // can say so, and a throwing spawn is the same answer.
  const throwing = await openUrlInBrowser('https://example.test/k', {
    platform: 'linux',
    spawnImpl: () => {
      throw new Error('no desktop session');
    },
  });
  assert.equal(throwing, null);
  assert.equal(
    await openUrlInBrowser('', { platform: 'linux', spawnImpl }),
    null,
  );
});

test('the browser is detached and inherited, so it outlives the server', async () => {
  const seen = [];
  const children = [];
  await openUrlInBrowser('https://example.test/k', {
    platform: 'win32',
    environment: WINDOWS.environment,
    fileSystem: fileSystem(braveOnWindows),
    spawnImpl: (command, args, options) => {
      seen.push({ command, options });
      return child('spawn', children);
    },
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].options, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.equal(children.length, 1);
  assert.equal(
    children[0].listenerCount('error'),
    1,
    'a late error cannot crash the server',
  );
});
