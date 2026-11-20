import test from 'node:test';
import assert from 'node:assert/strict';

import { TIMED_OUT, guardStartup, withinBudget } from './startupGuard.js';

test('a step that answers inside its budget is passed through', async () => {
  assert.equal(await withinBudget(Promise.resolve(7), 50), 7);
  assert.equal(await withinBudget('not a promise', 50), 'not a promise');
});

test('a step that never answers takes the degraded path', async () => {
  const answer = await withinBudget(new Promise(() => {}), 5, {
    onTimeout: () => 'keyless globe',
  });
  assert.equal(answer, 'keyless globe');
  assert.equal(
    await withinBudget(new Promise(() => {}), 5),
    undefined,
    'without a fallback the caller continues with nothing',
  );
});

test('a step that fails inside its budget still fails the startup', async () => {
  await assert.rejects(
    withinBudget(Promise.reject(new Error('provider refused')), 50),
    /provider refused/,
  );
});

test('a result that lands after the budget is handed on instead of leaked', async () => {
  let release;
  const late = new Promise((resolve) => {
    release = resolve;
  });
  const seen = [];
  const answer = await withinBudget(late, 5, {
    onTimeout: () => TIMED_OUT,
    onLate: (value) => seen.push(value),
  });
  assert.equal(answer, TIMED_OUT);
  release({ tileset: 'landed late' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [{ tileset: 'landed late' }]);
});

/** A clock the test fires by hand, so no assertion waits on a real timer. */
function fakeClock() {
  let pending = null;
  return {
    set(fn, ms) {
      pending = { fn, ms };
      return pending;
    },
    clear(handle) {
      if (pending === handle) pending = null;
    },
    fire() {
      const due = pending;
      pending = null;
      due?.fn();
    },
    get due() {
      return pending;
    },
    get armed() {
      return pending !== null;
    },
  };
}

function fakeApplication(state = { status: 'starting', phase: 'scene' }) {
  const listeners = new Set();
  return {
    state,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    set(next) {
      Object.assign(state, next);
      for (const listener of [...listeners]) listener(state);
    },
  };
}

function fakeCover() {
  const classes = new Set();
  const attributes = new Map();
  return {
    classes,
    attributes,
    classList: { add: (name) => classes.add(name) },
    setAttribute: (name, value) => attributes.set(name, value),
  };
}

test('a startup that outlives its budget names the step and lifts the cover', () => {
  const clock = fakeClock();
  const application = fakeApplication();
  const cover = fakeCover();
  const status = {
    textContent: 'Loading Google 3D Tiles...',
    style: { color: '#ff4444' },
  };
  const stop = guardStartup({
    application,
    cover,
    status,
    budgetMs: 30000,
    timers: clock,
  });

  assert.equal(clock.due.ms, 30000);
  clock.fire();

  assert.match(status.textContent, /Loading Google 3D Tiles\.\.\./);
  assert.match(status.textContent, /30 s/);
  assert.equal(status.style.color, '', 'the failure colour is cleared');
  assert.ok(cover.classes.has('hidden'), 'the console behind is revealed');
  assert.equal(cover.attributes.get('aria-hidden'), 'true');
  stop();
});

test('a startup that finishes inside its budget is left alone', () => {
  const clock = fakeClock();
  const application = fakeApplication();
  const cover = fakeCover();
  const status = { textContent: 'Initializing systems...', style: {} };
  const stop = guardStartup({
    application,
    cover,
    status,
    budgetMs: 30000,
    timers: clock,
  });

  application.set({ status: 'ready', phase: null });
  assert.equal(clock.armed, false, 'the guard stands down once ready');
  clock.fire();
  assert.equal(status.textContent, 'Initializing systems...');
  assert.ok(!cover.classes.has('hidden'), 'the cover keeps its own transition');
  stop();
});

test('stopping the guard disarms it', () => {
  const clock = fakeClock();
  const cover = fakeCover();
  const status = { textContent: 'Initializing systems...', style: {} };
  const stop = guardStartup({
    application: fakeApplication(),
    cover,
    status,
    budgetMs: 30000,
    timers: clock,
  });
  stop();
  assert.equal(clock.armed, false);
  assert.ok(!cover.classes.has('hidden'));
});
