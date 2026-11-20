import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESTORE_BUDGET_MS,
  startApplicationChrome,
} from '../app/startupChrome.js';

/*
 * Both modules import cleanly under Node, so this is the real chrome and the
 * real withinBudget on a hand-fired clock: one less harness to keep in step
 * with them.
 */

/** The loading cover, the two initializers, and a clock the test fires. */
function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(String(message)));
  const listeners = new Map();
  const controller = new AbortController();
  let restored;
  const stop = startApplicationChrome({
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
    initializeWelcome: () => {
      events.push('welcome');
      return { destroy: () => events.push('welcome:destroy') };
    },
    initializeSettings: () => ({
      destroy: () => events.push('settings:destroy'),
    }),
  });
  return {
    events,
    warnings,
    listeners,
    controller,
    stop,
    restore: () => restored(),
    tick: (ms) => t.mock.timers.tick(ms),
  };
}

/** Let every promise the chrome queued run before the next assertion. */
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

test('welcome waits for restoration, minimum delay, and the cover transition', async (t) => {
  const f = fixture(t);
  f.tick(1000);
  await flush();
  assert.deepEqual(f.events, []);
  f.restore();
  await flush();
  assert.deepEqual(f.events, ['hidden']);
  f.listeners.get('transitionend')();
  f.tick(900);
  assert.deepEqual(f.events, ['hidden', 'welcome']);
  await f.stop();
  assert.deepEqual(f.events.slice(-2), ['welcome:destroy', 'settings:destroy']);
  assert.deepEqual(f.warnings, []);
});

test('a restoration that never answers no longer holds the cover', async (t) => {
  const f = fixture(t);
  assert.equal(RESTORE_BUDGET_MS, 10000, 'restoration has its own deadline');
  f.tick(1000);
  await flush();
  assert.deepEqual(f.events, [], 'the cover still waits inside the budget');

  f.tick(RESTORE_BUDGET_MS);
  await flush();
  assert.deepEqual(
    f.events,
    ['hidden'],
    'the cover comes down on the deadline',
  );
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /restoration still pending after 10000 ms/);

  // An answer that lands afterwards changes nothing on screen and cannot throw.
  f.restore();
  await flush();
  assert.deepEqual(f.events, ['hidden']);
  await f.stop();
});

test('teardown leaves neither the deadline nor its warning behind', async (t) => {
  const f = fixture(t);
  f.tick(1000);
  await flush();
  await f.stop();
  f.tick(RESTORE_BUDGET_MS);
  await flush();
  assert.deepEqual(
    f.warnings,
    [],
    'a screen that is gone is not warned about a stall nobody sees',
  );
  assert.deepEqual(f.events, ['settings:destroy']);
});

test('reduced motion uses the bounded fallback after the cover hides', async (t) => {
  const f = fixture(t);
  f.restore();
  f.tick(1000);
  await flush();
  f.tick(900);
  assert.deepEqual(f.events, ['hidden', 'welcome']);
  await f.stop();
});

test('shutdown while restore is pending never reveals late welcome UI', async (t) => {
  const f = fixture(t);
  f.controller.abort();
  await f.stop();
  f.restore();
  await flush();
  f.tick(1000);
  f.tick(900);
  assert.deepEqual(f.events, ['settings:destroy']);
  assert.equal(f.listeners.size, 0);
  assert.deepEqual(f.warnings, []);
});

test('shutdown during the cover transition cancels the listener and fallback', async (t) => {
  const f = fixture(t);
  f.restore();
  f.tick(1000);
  await flush();
  const transition = f.listeners.get('transitionend');
  f.controller.abort();
  await f.stop();
  transition();
  f.tick(900);
  assert.deepEqual(f.events, ['hidden', 'settings:destroy']);
});
