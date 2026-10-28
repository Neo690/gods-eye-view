import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDensity,
  DENSITY_BACKOFF_BASE_MS,
  DENSITY_BACKOFF_MAX_MS,
  DENSITY_FAILURE_LIMIT,
  DENSITY_MIN_GAP_MS,
  DENSITY_POLL_MS,
  DENSITY_RENDER_DELAY_SEC,
} from './density.js';

/**
 * A density session on a clock and a timer queue the test drives by hand, so
 * every delay in the policy is asserted as a number rather than waited out.
 */
function harness({ results = [true] } = {}) {
  let clock = 1_000;
  let index = 0;
  const timers = [];
  const refreshes = [];
  const feed = {};
  const session = createDensity({
    feed,
    refresh: async (viewer, options) => {
      refreshes.push({ viewer, ...options });
      return results[Math.min(index++, results.length - 1)];
    },
    getViewer: () => ({ camera: 'fixture' }),
    now: () => clock,
    setTimeoutImpl: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => {
      handle.cleared = true;
    },
  });
  const live = () => timers.filter((timer) => !timer.cleared);
  return {
    session,
    feed,
    refreshes,
    /** Advance the clock and run everything that is now due. */
    async advance(ms) {
      clock += ms;
      const due = timers.filter((timer) => !timer.cleared);
      timers.length = 0;
      for (const timer of due) await timer.fn();
    },
    /** The one timer still armed, or null. */
    pending() {
      const armed = live();
      return armed.length ? armed[0] : null;
    },
    clockNow: () => clock,
  };
}

test('density polls at 5 s with a viewport read, and only while started', async () => {
  const h = harness();

  h.session.start();
  assert.equal(h.feed._densityLive, true);
  assert.equal(h.pending().ms, DENSITY_POLL_MS);

  await h.advance(DENSITY_POLL_MS);
  assert.equal(h.refreshes.length, 1);
  assert.equal(h.refreshes[0].dense, true);
  assert.deepEqual(h.refreshes[0].viewer, { camera: 'fixture' });
  assert.equal(h.pending().ms, DENSITY_POLL_MS);

  await h.advance(DENSITY_POLL_MS);
  assert.equal(h.refreshes.length, 2);
  assert.equal(h.session.getStatus().applied, 2);
});

test('a second attempt inside the 1 s floor waits it out instead of bursting', async () => {
  const h = harness();

  h.session.start();
  await h.advance(DENSITY_POLL_MS);
  assert.equal(h.refreshes.length, 1);

  // A camera move asks for a patch 200 ms after the last one.
  h.session.nudge();
  h.session.nudge();
  assert.equal(h.refreshes.length, 1, 'no second request was issued');
  assert.equal(h.pending().ms, DENSITY_MIN_GAP_MS);

  await h.advance(DENSITY_MIN_GAP_MS);
  assert.equal(h.refreshes.length, 2);
});

test('failures back off step by step, stand down, then recover', async () => {
  const h = harness({ results: [false, false, false, true] });

  h.session.start();
  await h.advance(DENSITY_POLL_MS);
  assert.equal(h.pending().ms, DENSITY_BACKOFF_BASE_MS);

  await h.advance(DENSITY_BACKOFF_BASE_MS);
  assert.equal(h.pending().ms, DENSITY_BACKOFF_BASE_MS * 2);

  await h.advance(DENSITY_BACKOFF_BASE_MS * 2);
  assert.equal(h.pending().ms, DENSITY_BACKOFF_MAX_MS);
  assert.equal(h.session.getStatus().failures, DENSITY_FAILURE_LIMIT);
  assert.equal(h.session.getStatus().degraded, true);

  // The slow retry succeeds: the mode returns to its 5 s cadence.
  await h.advance(DENSITY_BACKOFF_MAX_MS);
  assert.equal(h.refreshes.length, 4);
  assert.equal(h.pending().ms, DENSITY_POLL_MS);
  assert.equal(h.session.getStatus().failures, 0);
  assert.equal(h.session.getStatus().degraded, false);
});

test('stopping ends the session: no timer, no further reads, live flag cleared', async () => {
  const h = harness();

  h.session.start();
  await h.advance(DENSITY_POLL_MS);
  assert.equal(h.refreshes.length, 1);

  h.session.stop();
  assert.equal(h.pending(), null);
  assert.equal(h.feed._densityLive, false);
  assert.equal(h.session.getStatus().polling, false);

  // A later clock advance has nothing armed, so nothing is requested.
  await h.advance(DENSITY_POLL_MS * 4);
  assert.equal(h.refreshes.length, 1);
});

test('a read that is aborted by stop does not reschedule', async () => {
  const aborted = new AbortController();
  let clock = 1_000;
  const timers = [];
  const session = createDensity({
    feed: {},
    refresh: async () => {
      aborted.abort();
      session.stop();
      throw new DOMException('aborted', 'AbortError');
    },
    getViewer: () => ({}),
    now: () => clock,
    setTimeoutImpl: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => {
      handle.cleared = true;
    },
  });
  session.start();
  clock += DENSITY_POLL_MS;
  const due = timers.filter((timer) => !timer.cleared);
  timers.length = 0;
  for (const timer of due) await timer.fn();
  assert.equal(
    timers.filter((timer) => !timer.cleared).length,
    0,
    'no follow-up timer after an aborted read',
  );
});

test('the display delay follows the patch cadence it renders', () => {
  assert.equal(DENSITY_RENDER_DELAY_SEC, DENSITY_POLL_MS / 1000);
  assert.equal(DENSITY_RENDER_DELAY_SEC, 5);
});

test('the layer renders at its poll cadence: 30 s by default, one patch while dense', async () => {
  const { RENDER_DELAY_SEC, DENSITY_RENDER_DELAY_SEC, renderDelaySec } =
    await import('./policy.js');
  assert.equal(RENDER_DELAY_SEC, 30);
  assert.equal(renderDelaySec(undefined), 30);
  assert.equal(renderDelaySec({}), 30);
  // A value the mode never writes must not be trusted.
  assert.equal(renderDelaySec({ _renderDelaySec: 0 }), 30);
  assert.equal(renderDelaySec({ _renderDelaySec: Number.NaN }), 30);
  assert.equal(
    renderDelaySec({ _renderDelaySec: DENSITY_RENDER_DELAY_SEC }),
    5,
  );
});
