import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Neither module can be imported here: both pull in browser code. Their text is
// evaluated in one context instead, so the chrome calls the real withinBudget
// of startupGuard.js on the fixture's clock rather than a stand-in for it.
function load(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export /gm, '');
}

const guardSource = load('../app/startupGuard.js');
const chromeSource = load('../app/startupChrome.js');

function fixture() {
  const timers = new Map();
  const listeners = new Map();
  const events = [];
  const logs = [];
  let restored;
  let nextTimer = 0;
  const controller = new AbortController();
  const context = {
    console: {
      error: console.error,
      warn: (message) => logs.push(String(message)),
    },
    t: (message) => message,
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    initFirstRunExperience() {
      events.push('welcome');
      return { destroy: () => events.push('welcome:destroy') };
    },
    async initKeySetup() {
      return { destroy: () => events.push('settings:destroy') };
    },
  };
  vm.createContext(context);
  vm.runInContext(guardSource, context);
  vm.runInContext(chromeSource, context);
  const stop = context.startApplicationChrome({
    initializeSettings: context.initKeySetup,
    loadingScreen: {
      classList: { add: (value) => events.push(value) },
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type) => listeners.delete(type),
    },
    styleManager: {
      initialRestorePromise: new Promise((resolve) => {
        restored = resolve;
      }),
    },
    dataManager: {},
    signal: controller.signal,
  });
  return {
    events,
    listeners,
    logs,
    stop,
    restored,
    controller,
    budgetMs: vm.runInContext('RESTORE_BUDGET_MS', context),
    fire(delay) {
      for (const [id, task] of timers) {
        if (task.delay === delay) {
          timers.delete(id);
          task.fn();
        }
      }
    },
    delays() {
      return [...timers.values()].map((task) => task.delay);
    },
    timers,
  };
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

test('welcome waits for restoration, minimum delay, and the cover transition', async () => {
  const f = fixture();
  f.fire(1000);
  await flush();
  assert.deepEqual(f.events, []);
  f.restored();
  await flush();
  assert.deepEqual(f.events, ['hidden']);
  f.listeners.get('transitionend')();
  f.fire(900);
  assert.deepEqual(f.events, ['hidden', 'welcome']);
  await f.stop();
  assert.deepEqual(f.events.slice(-2), ['welcome:destroy', 'settings:destroy']);
  assert.equal(f.timers.size, 0);
});

test('a restoration that never answers no longer holds the cover', async () => {
  const f = fixture();
  assert.equal(f.budgetMs, 10000, 'restoration has its own deadline');
  f.fire(1000);
  await flush();
  assert.deepEqual(f.events, [], 'the cover still waits inside the budget');
  assert.ok(
    f.delays().includes(f.budgetMs),
    'the deadline is armed while restoration runs',
  );

  f.fire(f.budgetMs);
  await flush();
  assert.deepEqual(
    f.events,
    ['hidden'],
    'the cover comes down on the deadline',
  );
  assert.match(
    f.logs.join('\n'),
    new RegExp(`restoration still pending after ${f.budgetMs} ms`),
  );

  // An answer that lands afterwards changes nothing on screen and cannot throw.
  f.restored();
  await flush();
  assert.deepEqual(f.events, ['hidden']);
  await f.stop();
  assert.equal(f.timers.size, 0);
});

test('reduced motion uses the bounded fallback after the cover hides', async () => {
  const f = fixture();
  f.restored();
  f.fire(1000);
  await flush();
  f.fire(900);
  assert.deepEqual(f.events, ['hidden', 'welcome']);
  await f.stop();
});

test('shutdown while restore is pending never reveals late welcome UI', async () => {
  const f = fixture();
  f.controller.abort();
  await f.stop();
  f.restored();
  await flush();
  f.fire(1000);
  f.fire(900);
  assert.deepEqual(f.events, ['settings:destroy']);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.timers.size, 0);
});

test('shutdown during the cover transition cancels the listener and fallback', async () => {
  const f = fixture();
  f.restored();
  f.fire(1000);
  await flush();
  const transition = f.listeners.get('transitionend');
  f.controller.abort();
  await f.stop();
  transition();
  f.fire(900);
  assert.deepEqual(f.events, ['hidden', 'settings:destroy']);
});
