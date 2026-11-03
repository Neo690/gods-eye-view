import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SENTINEL_WINDOWS,
  createSentinelWatch,
  eventSeverity,
  readStrongRecord,
  resolveSeverity,
  watchLayers,
  worstSeverity,
} from './watch.js';
import { MAX_ACTIONS_PER_PLAN, safePlanActions } from './planner.js';
import { createAiAgentLayer } from './index.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Minimal DOM facade covering exactly the surface overlay.js touches. */
class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.className = '';
    this.dataset = { state: '' };
    this.hidden = false;
    this.textContent = '';
    this.title = '';
    this.children = [];
    this.parent = null;
    this._html = '';
    this._listeners = new Map();
    this._classes = new Set();
    this._standins = new Map();
    this._attrs = {};
  }

  get childElementCount() {
    return this.children.length;
  }
  get lastElementChild() {
    return this.children[this.children.length - 1] ?? null;
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(value) {
    this._html = value;
  }

  get classList() {
    const classes = this._classes;
    return {
      toggle(value, on = !classes.has(value)) {
        if (on) classes.add(value);
        else classes.delete(value);
      },
      add(value) {
        classes.add(value);
      },
      contains(value) {
        return classes.has(value);
      },
    };
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  prepend(child) {
    child.parent = this;
    this.children.unshift(child);
    return child;
  }
  remove() {
    if (this.parent) {
      const at = this.parent.children.indexOf(this);
      if (at >= 0) this.parent.children.splice(at, 1);
      this.parent = null;
    }
  }
  addEventListener(type, handler) {
    this._listeners.set(type, handler);
  }
  click() {
    this._listeners.get('click')?.();
  }
  setAttribute(key, value) {
    this._attrs[key] = value;
  }
  getAttribute(key) {
    return this._attrs[key] ?? null;
  }
  querySelector(selector) {
    // overlay.js reads its own children by class; stand-ins are memoized per
    // selector so repeated reads surface the same node.
    let node = this._standins.get(selector);
    if (!node) {
      node = new FakeElement('div');
      this._standins.set(selector, node);
    }
    return node;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
  }
  createElement(tagName) {
    return new FakeElement(tagName);
  }
}

/** A lifecycle row in the manager's shape, with only the fields that matter. */
function row(id, { name = id, count = 0, loading = false, error = null } = {}) {
  return {
    id,
    name,
    enabled: true,
    stats: {
      count,
      loading,
      ...(error
        ? { sourceUnavailable: false, managerRefreshError: error }
        : {}),
    },
  };
}

/** Manager fake carrying the three channels createSentinelWatch binds. */
function fakeDataManager() {
  const channels = {
    onSnapshotUpdate: [],
    onLayerState: [],
    onLayerError: [],
  };
  const subscribe = (channel) => (listener) => {
    channels[channel].push(listener);
    return () => {
      const at = channels[channel].indexOf(listener);
      if (at >= 0) channels[channel].splice(at, 1);
    };
  };
  return {
    channels,
    onSnapshotUpdate: subscribe('onSnapshotUpdate'),
    onLayerState: subscribe('onLayerState'),
    onLayerError: subscribe('onLayerError'),
  };
}

const REAL_NOW = Date.now;
/** Install a controllable clock for the dedup-window tests. */
function withFakeClock() {
  let clock = REAL_NOW();
  Date.now = () => clock;
  return {
    tick(ms) {
      clock += ms;
    },
    restore() {
      Date.now = REAL_NOW;
    },
  };
}

// ---------------------------------------------------------------------------
// readStrongRecord + watchLayers: diffs, first-sight arming, loading grace
// ---------------------------------------------------------------------------

test('readStrongRecord surfaces the error the manager owns', () => {
  assert.deepEqual(
    readStrongRecord({
      id: 'a',
      name: 'A',
      enabled: true,
      stats: { count: 3 },
    }),
    {
      id: 'a',
      label: 'A',
      enabled: true,
      loading: false,
      count: 3,
      error: null,
    },
  );
  assert.equal(
    readStrongRecord({ id: 'a', stats: { managerRefreshError: '500' } }).error,
    '500',
  );
  assert.equal(
    readStrongRecord({
      id: 'a',
      stats: { sourceUnavailable: true, error: 'no source' },
    }).error,
    'no source',
  );
  assert.equal(
    readStrongRecord({
      id: 'a',
      stats: { sourceUnavailable: false, error: 'ignored' },
    }).error,
    null,
    'a source error while the source reports available is not surfaced',
  );
  assert.equal(readStrongRecord(undefined).id, '');
});

// The seen set is the caller's: watchLayers never (re)creates it in state, so
// a fresh Set per pass would re-arm every cycle. The layer owns
// { previous, seen } exactly once and hands it back in.
const watchdogState = () => ({ previous: null, seen: new Set() });

/** One full pass: watch, then hand the fresh previous map back to state —
 * exactly what index.js does between its cycles. */
function passRows(state, opts, rows) {
  const result = watchLayers(rows, state, opts);
  state.previous = result.previous;
  return result;
}

test('watchLayers stays silent on first sight, then diffs count changes', () => {
  const state = watchdogState();
  const at = () => 1000;
  const opts = { now: at };

  // First pass only arms the baseline: startup noise never floods the feed.
  let pass = passRows(state, opts, [row('flights', { count: 5 })]);
  assert.deepEqual(pass.events, []);

  // No change: no event either.
  pass = passRows(state, opts, [row('flights', { count: 5 })]);
  assert.deepEqual(pass.events, []);

  // Count rising: one event-update with the signed delta in the detail.
  pass = passRows(state, opts, [row('flights', { count: 9 })]);
  assert.equal(pass.events.length, 1);
  assert.equal(pass.events[0].kind, 'event-update');
  assert.equal(pass.events[0].layerId, 'flights');
  assert.equal(pass.events[0].detail, '+4');
  assert.equal(pass.events[0].severity, 'info');
  assert.equal(pass.events[0].at, 1000);
  assert.ok(Object.isFrozen(pass.events[0]));

  // Falling count: unicode minus, never the ascii hyphen.
  pass = passRows(state, opts, [row('flights', { count: 8 })]);
  assert.equal(pass.events[0].detail, '−1');

  // The layer owns one state object: previous is replaced, seen is kept.
  assert.ok(pass.previous instanceof Map);
  assert.equal(pass.previous.get('flights').count, 8);
  assert.ok(state.seen instanceof Set);
});

test('watchLayers skips loading ticks in both directions', () => {
  const state = watchdogState();
  const at = () => 2000;
  const opts = { now: at };

  passRows(state, opts, [row('flights', { count: 3 })]); // baseline arms silently

  // A loading tick with a changed count is not news.
  let pass = passRows(state, opts, [
    row('flights', { count: 9, loading: true }),
  ]);
  assert.deepEqual(pass.events, []);

  // Nor the tick that merely clears it.
  pass = passRows(state, opts, [row('flights', { count: 9, loading: false })]);
  assert.deepEqual(pass.events, []);

  // The next settled tick carries the diff the loading window skipped.
  pass = passRows(state, opts, [row('flights', { count: 12 })]);
  assert.deepEqual(
    pass.events.map((event) => event.detail),
    ['+3'],
  );
});

test('watchLayers escalates a NEW feed error to warn before counting anything else', () => {
  const state = watchdogState();
  const at = () => 3000;
  const opts = { now: at };

  passRows(state, opts, [row('flights', { count: 5 })]); // baseline
  const pass = passRows(state, opts, [
    row('flights', { count: 7, error: 'upstream 503' }),
  ]);
  assert.equal(pass.events.length, 1);
  assert.equal(pass.events[0].kind, 'layer-error');
  assert.equal(pass.events[0].severity, 'warn');
  assert.equal(pass.events[0].detail, 'upstream 503');

  // The same error repeated is not news again.
  const again = passRows(state, opts, [
    row('flights', { count: 7, error: 'upstream 503' }),
  ]);
  assert.deepEqual(again.events, []);
});

test('watchLayers ignores rows without an id under a custom reader', () => {
  const state = watchdogState();
  const opts = {
    now: () => 4,
    readRecords: (raw) => ({ id: String(raw.id ?? ''), label: raw.id }),
  };
  const pass = watchLayers([{ id: '' }, { id: 'ok' }], state, opts);
  assert.deepEqual(pass.events, []);
  assert.equal(pass.previous.size, 1);
});

test('watchLayers tolerates a null roster, but always needs the seen set', () => {
  assert.deepEqual(
    watchLayers(null, watchdogState(), { now: () => 5 }).events,
    [],
  );
  // Without a seen set the engine cannot remember its first sight and re-arms
  // every pass: a miswired caller yields silence, not a flood.
  const stateless = {};
  for (let pass = 0; pass < 3; pass++) {
    const result = watchLayers([row('flights', { count: pass })], stateless, {
      now: () => 6,
    });
    assert.deepEqual(result.events, []);
  }
});

// ---------------------------------------------------------------------------
// Severity helpers (the renderer consumes these verbatim)
// ---------------------------------------------------------------------------

test('worstSeverity and resolveSeverity follow the documented ladder', () => {
  assert.equal(worstSeverity([]), 'info');
  assert.equal(
    worstSeverity([{ severity: 'info' }, { severity: 'emergency' }]),
    'emergency',
  );
  assert.equal(
    worstSeverity([{ severity: 'warn' }, { severity: 'emergency' }]),
    'emergency',
  );
  assert.equal(worstSeverity([{}]), 'info', 'unmapped severity reads calm');

  assert.equal(eventSeverity(null), 'info');
  assert.equal(eventSeverity({ severity: 'nope' }), 'info');

  assert.equal(resolveSeverity('lost'), 'warn');
  assert.equal(resolveSeverity('error'), 'warn');
  assert.equal(resolveSeverity('state'), 'info');
  assert.equal(resolveSeverity('new', { magnitude: 4.2 }), 'warn');
  assert.equal(resolveSeverity('new', { magnitude: 5.0 }), 'emergency');
  assert.equal(resolveSeverity('new', { magnitude: 'n/a' }), 'warn');
});

test('SENTINEL_WINDOWS exports the engine timings verbatim', () => {
  assert.deepEqual(SENTINEL_WINDOWS, { grace: 12000, dedup: 120000 });
});

// ---------------------------------------------------------------------------
// createSentinelWatch: arming, burst caps, dedup window, bind/destroy contract
// ---------------------------------------------------------------------------

// The 12s grace sweep (the 20k-id book pruning) is a memory-hygiene detail
// with no observable surface: LOST detection diffs against lastReadIds, not
// the book. It is pinned through SENTINEL_WINDOWS above.

test('sentinel watch: first read arms, second read emits capped NEW with magnitude', () => {
  const clock = withFakeClock();
  try {
    const manager = fakeDataManager();
    const watch = createSentinelWatch({ dataManager: manager });
    const seen = [];
    const off = watch.addListener((event) => seen.push(event));

    // bind() returns the undo on the FIRST call; re-binding is a no-op.
    const undo = watch.bind();
    assert.equal(typeof undo, 'function');
    assert.equal(watch.bind(), null);

    const rowsFor = (n) =>
      Array.from({ length: n }, (_, i) => ({ id: `ev-${i}`, magnitude: 3.1 }));
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({ layerId: 'emsc-seismic', rows: rowsFor(20) }),
    );
    assert.deepEqual(seen, [], 'first read arms silently');

    clock.tick(1000);
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({ layerId: 'emsc-seismic', rows: rowsFor(25) }),
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'new');
    assert.equal(seen[0].count, 5);
    assert.deepEqual(seen[0].subjects, [
      'ev-20',
      'ev-21',
      'ev-22',
      'ev-23',
      'ev-24',
    ]);
    assert.equal(seen[0].magnitude, 3.1, 'the strongest read row is claimed');
    assert.equal(seen[0].severity, 'warn', 'below magnitude 5 stays a warning');
    assert.ok(seen[0].id.startsWith('ev_'));
    assert.ok(Object.isFrozen(seen[0]));

    off();
  } finally {
    clock.restore();
  }
});

const BURST_ROW_COUNT = 22;

test('sentinel watch: burst caps subjects at 20 and escalates magnitude ≥ 5', () => {
  const clock = withFakeClock();
  try {
    const manager = fakeDataManager();
    const watch = createSentinelWatch({ dataManager: manager });
    const seen = [];
    watch.addListener((event) => seen.push(event));
    watch.bind();

    const rowsFor = (n) =>
      Array.from({ length: n }, (_, i) => ({ eventId: `id-${i}`, mag: 6.2 }));
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({ layerId: 'emsc-seismic', rows: rowsFor(2) }),
    );
    clock.tick(1000);
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({ layerId: 'emsc-seismic', rows: rowsFor(BURST_ROW_COUNT) }),
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].count, BURST_ROW_COUNT - 2);
    assert.equal(
      seen[0].subjects.length,
      20,
      'BURST_CAP holds on a 22-row burst',
    );
    assert.equal(seen[0].magnitude, 6.2);
    assert.equal(seen[0].severity, 'emergency');
    watch.destroy();
  } finally {
    clock.restore();
  }
});

test('sentinel watch: LOST dedup — a repeated identical loss stays silent, a post-window repeat fires', () => {
  const clock = withFakeClock();
  try {
    const manager = fakeDataManager();
    const watch = createSentinelWatch({ dataManager: manager });
    const seen = [];
    watch.addListener((event) => seen.push(event));
    watch.bind();

    const rowsFor = (ids) => ids.map((id) => ({ id }));
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({ layerId: 'emsc-seismic', rows: rowsFor(['ev-0']) }),
    );
    clock.tick(60_000);
    // Flicker in, so a LOST of exactly ev-1 exists.
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({ layerId: 'emsc-seismic', rows: rowsFor(['ev-0', 'ev-1']) }),
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'new');
    // The loss itself: dead within the dedup window.
    clock.tick(1000);
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({ layerId: 'emsc-seismic', rows: rowsFor(['ev-0']) }),
    );
    const lostEvents = () => seen.filter((event) => event.kind === 'lost');
    assert.equal(lostEvents().length, 1);
    assert.deepEqual(lostEvents()[0].subjects, ['ev-1']);

    // Flicker once more and kill it again: the same batch is swallowed while
    // the window holds.
    clock.tick(1000);
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({ layerId: 'emsc-seismic', rows: rowsFor(['ev-0', 'ev-1']) }),
    );
    clock.tick(1000);
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({ layerId: 'emsc-seismic', rows: rowsFor(['ev-0']) }),
    );
    assert.equal(
      lostEvents().length,
      1,
      'identical loss still deduped inside the window',
    );

    // Past the window the same loss reports again.
    clock.tick(SENTINEL_WINDOWS.dedup + 1);
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({ layerId: 'emsc-seismic', rows: rowsFor(['ev-0', 'ev-1']) }),
    );
    clock.tick(1000);
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({ layerId: 'emsc-seismic', rows: rowsFor(['ev-0']) }),
    );
    assert.equal(lostEvents().length, 2);
    assert.deepEqual(lostEvents()[1].subjects, ['ev-1']);

    watch.destroy();
  } finally {
    clock.restore();
  }
});

test('sentinel watch: id fallback chain and rows without any tracked id', () => {
  const clock = withFakeClock();
  try {
    const manager = fakeDataManager();
    const watch = createSentinelWatch({ dataManager: manager });
    const seen = [];
    watch.addListener((event) => seen.push(event));
    watch.bind();

    // First read: 'weather-cyclones' reads id then sid; only these exist.
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({
        layerId: 'weather-cyclones',
        rows: [{ id: 'a' }, { id: 'b' }],
      }),
    );
    assert.deepEqual(seen, [], 'first read arms silently');

    const news = () => seen.filter((event) => event.kind === 'new');
    const losts = () => seen.filter((event) => event.kind === 'lost');

    clock.tick(1000);
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({
        layerId: 'weather-cyclones',
        rows: [{ id: 'a' }, { sid: 's1' }],
      }),
    );
    const newEvent = news()[0];
    assert.ok(newEvent, 'the sid-only row shows up as new');
    assert.equal(newEvent.count, 1);
    assert.deepEqual(
      newEvent.subjects,
      ['s1'],
      'the fallback field wins when id is absent',
    );
    assert.equal(
      newEvent.severity,
      'warn',
      'no magnitude fields for this layer → plain warning',
    );
    assert.equal(newEvent.magnitude, undefined);
    assert.equal(
      losts().length,
      1,
      'the old id-b read as lost in the same snapshot',
    );

    // A snapshot where no row carries any tracked id reads as a total loss.
    clock.tick(1000);
    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({ layerId: 'weather-cyclones', rows: [{ mystery: 'x' }] }),
    );
    const lost = losts().at(-1);
    assert.equal(lost.count, 2);
    assert.deepEqual(lost.subjects, ['a', 's1']);

    manager.channels.onSnapshotUpdate.forEach((listener) =>
      listener({ layerId: 'not-a-layer', rows: [{ id: 'x' }] }),
    );
    assert.equal(seen.length, 3, 'a layer with no id rule contributes nothing');
    watch.destroy();
  } finally {
    clock.restore();
  }
});

test('sentinel watch: state flows instantly, error dedups by message', () => {
  const clock = withFakeClock();
  try {
    const manager = fakeDataManager();
    const watch = createSentinelWatch({ dataManager: manager });
    const seen = [];
    watch.addListener((event) => seen.push(event));
    watch.bind();

    manager.channels.onLayerState.forEach((listener) =>
      listener({ layerId: 'flights', enabled: false }),
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'state');
    assert.equal(seen[0].enabled, false);
    assert.equal(seen[0].severity, 'info');

    // State events are not deduped: an explicit toggle is always news.
    manager.channels.onLayerState.forEach((listener) =>
      listener({ layerId: 'flights', enabled: true }),
    );
    assert.equal(seen.length, 2);
    assert.equal(seen[1].enabled, true);

    manager.channels.onLayerError.forEach((listener) =>
      listener({ layerId: 'flights', error: new Error('feed down') }),
    );
    assert.equal(seen.at(-1).kind, 'error');
    assert.equal(seen.at(-1).severity, 'warn');
    assert.equal(seen.at(-1).message, 'feed down');

    // The same message within DEDUP_MS lands once; a new message lands again.
    clock.tick(1000);
    manager.channels.onLayerError.forEach((listener) =>
      listener({ layerId: 'flights', error: new Error('feed down') }),
    );
    clock.tick(1000);
    manager.channels.onLayerError.forEach((listener) =>
      listener({ layerId: 'flights', error: new Error('different failure') }),
    );
    assert.equal(seen.filter((event) => event.kind === 'error').length, 2);
    watch.destroy();
  } finally {
    clock.restore();
  }
});

test('sentinel watch: contract guards — manager required, bind once, destroy idempotent', () => {
  assert.throws(() => createSentinelWatch({}), TypeError);
  assert.throws(() => createSentinelWatch({ dataManager: 'x' }), TypeError);

  const manager = fakeDataManager();
  const watch = createSentinelWatch({ dataManager: manager });
  let boomed = false;
  const seen = [];
  watch.addListener(() => {
    if (!boomed) {
      boomed = true;
      throw new Error('listener boom');
    }
  });
  watch.addListener((event) => seen.push(event));
  watch.bind();

  // A listener throwing must not break the batch for the others.
  assert.doesNotThrow(() =>
    manager.channels.onLayerState.forEach((listener) =>
      listener({ layerId: 'flights', enabled: true }),
    ),
  );
  assert.equal(seen.length, 1);

  watch.destroy();
  watch.destroy(); // idempotent
  manager.channels.onLayerState.forEach((listener) =>
    listener({ layerId: 'flights', enabled: false }),
  );
  assert.equal(seen.length, 1, 'a destroyed engine never emits');
  assert.equal(watch.bind(), null, 'a destroyed engine never rebinds');
});

// ---------------------------------------------------------------------------
// safePlanActions: whitelisted names, self-disable refusal, caps, cloning
// ---------------------------------------------------------------------------

test('safePlanActions keeps only schema-known agent actions and caps the plan', () => {
  const safe = safePlanActions([
    {
      action: 'set_layer_visibility',
      args: { layerId: 'flights', enabled: true },
    },
    { action: 'zoom_to_globe', args: {} },
    { action: 'toggle_hud', args: { visible: false } },
    { action: 'focus_city', args: { city: 'Tokyo' } },
    { action: 'adjust_camera_heading', args: { deg: 30 } }, // past the cap
  ]);
  assert.equal(safe.length, MAX_ACTIONS_PER_PLAN);
  assert.deepEqual(
    safe.map((plan) => plan.name),
    ['set_layer_visibility', 'zoom_to_globe', 'toggle_hud'],
  );
});

test('safePlanActions refuses any action targeting the ai-agent layer itself', () => {
  const safe = safePlanActions([
    {
      action: 'set_layer_visibility',
      args: { layerId: 'emsc-seismic', enabled: true },
    },
    {
      action: 'set_layer_visibility',
      args: { layerId: 'ai-agent', enabled: false },
    },
    { action: 'set_layer_visibility', args: {} }, // no layerId either
    {
      action: 'set_layer_visibility',
      args: { layerId: 'ai-agent', enabled: true },
    },
  ]);
  assert.deepEqual(safe, [
    {
      name: 'set_layer_visibility',
      args: { layerId: 'emsc-seismic', enabled: true },
    },
  ]);
});

test('safePlanActions drops malformed and unknown entries, clones arguments', () => {
  const deep = { layerId: 'flights', enabled: true };
  const safe = safePlanActions([
    { action: 'set_layer_visibility', args: deep },
    { action: 'run_shell', args: { cmd: 'rm -rf /' } },
    { action: 'set_context_mode', args: { mode: 'dark' } },
    'a bare string entry',
    null,
    { args: {} }, // no action name
  ]);
  assert.deepEqual(safe, [
    {
      name: 'set_layer_visibility',
      args: { layerId: 'flights', enabled: true },
    },
  ]);
  // Arguments are cloned: mutating the plan afterwards cannot reach the runner.
  deep.layerId = 'ai-agent';
  assert.equal(safe[0].args.layerId, 'flights');
  assert.notEqual(safe[0].args, deep);
});

test('safePlanActions slices the budget BEFORE filtering: junk still eats slots', () => {
  // Three malformed entries at the head consume the whole plan of three.
  assert.deepEqual(
    safePlanActions([
      'junk',
      { action: 'not-a-real-tool' },
      null,
      { action: 'zoom_to_globe', args: {} },
    ]),
    [],
    'the slice precedes the whitelist, exactly as shipped; the model is capped upstream too',
  );
});

test('safePlanActions never explodes on garbage plans', () => {
  assert.deepEqual(safePlanActions(undefined), []);
  assert.deepEqual(safePlanActions('not an array'), []);
  assert.deepEqual(safePlanActions([]), []);
  assert.deepEqual(safePlanActions([{}, 3]), []);
});

// ---------------------------------------------------------------------------
// The layer itself: the avatar driven through docScope (node, no browser)
// ---------------------------------------------------------------------------

test('the layer works headless while everything stays watchdog-only', async () => {
  const rows = [];
  const layer = createAiAgentLayer({});
  layer.attachDataManager({ getAll: () => rows });
  assert.equal(layer.updateInterval, 30_000);
  assert.equal(layer.init({}), true);
  assert.equal(layer.enable(), true);
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().mode, 'watchdog');
  assert.equal(layer.getStats().loading, false);
});

test('actions only run through the attached runner — never self-constructed', async () => {
  const layer = createAiAgentLayer({});
  const runs = [];
  layer.attachActionControl({
    actionRunner: async (name, args) => runs.push([name, args]),
    styleManager: {},
  });
  assert.equal(layer.getStats().mode, 'autonomous');
  // Nothing planned yet: the session has neither reached its plan slot nor
  // called update(), and the layer disables without a system prompt of its own.
  assert.deepEqual(runs, []);
  // A destroy wipes the attached runner: state returns to watchdog-only.
  layer.destroy();
  assert.equal(layer.getStats().mode, 'watchdog');
});

test('the layer refuses a second init with the viewer still attached', () => {
  const layer = createAiAgentLayer({});
  layer.init({});
  assert.throws(() => layer.init({}), /already initialized/);
});

test('the avatar mounts on the docScope document and follows severity', async () => {
  const dom = new FakeDocument();
  const rows = [];
  let clock = REAL_NOW();
  const layer = createAiAgentLayer({ docScope: dom, now: () => clock });
  layer.attachDataManager({ getAll: () => rows });

  layer.init({});
  const root = dom.body.children[0];
  assert.equal(root.className, 'gev-ai-agent');
  assert.equal(root.dataset.state, 'idle');

  layer.enable();
  assert.ok(!root.classList.contains('asleep'));

  rows.push(row('flights', { name: 'Live Flights', count: 0 }));
  await layer.update(); // re-arms the baseline (same rows, same clock)
  clock += 1000;
  rows[0].stats.count = 3;
  await layer.update(); // now the delta is news

  assert.equal(root.dataset.state, 'calm', 'an info-severity event glows calm');
  const feed = root.querySelector('.gev-ai-agent-feed');
  assert.equal(feed.childElementCount, 1);
  assert.match(feed.children[0].textContent, /Live Flights — \+3/);
  const bubble = root.querySelector('.gev-ai-agent-bubble');
  assert.match(bubble.textContent, /\+3/);

  // A disable folds the avatar into its dormant orb.
  layer.disable();
  assert.ok(root.classList.contains('asleep'));
  assert.equal(await layer.update(), false, 'a disabled layer does not watch');
  layer.destroy();
  assert.equal(dom.body.children.length, 0, 'destroy removes the overlay root');
  assert.equal(await layer.update(), false, 'a destroyed layer does not watch');
});

test('the avatar feed is bounded by the same cap the overlay promises', async () => {
  const dom = new FakeDocument();
  const rows = [];
  let clock = REAL_NOW();
  const layer = createAiAgentLayer({ docScope: dom, now: () => clock });
  layer.attachDataManager({ getAll: () => rows });
  layer.init({});
  layer.enable();

  rows.push(row('flights', { count: 0 }));
  await layer.update();
  for (let step = 1; step <= 20; step++) {
    clock += 1000;
    rows[0].stats.count = step;
    await layer.update();
  }
  const feed = dom.body.children[0].querySelector('.gev-ai-agent-feed');
  assert.ok(
    feed.childElementCount <= 12,
    'the overlay keeps at most 12 feed rows',
  );
  // The layer's own event pool is capped at 30 regardless of the overlay.
  assert.ok(layer.getStats().count <= 30);
  layer.destroy();
});

test('the layer forgets events past the ten-minute memory window', async () => {
  const dom = new FakeDocument();
  const rows = [];
  let clock = REAL_NOW();
  const layer = createAiAgentLayer({ docScope: dom, now: () => clock });
  layer.attachDataManager({ getAll: () => rows });
  layer.init({});
  layer.enable();

  rows.push(row('flights', { count: 0 }));
  await layer.update();
  clock += 1000;
  rows[0].stats.count = 2;
  await layer.update();
  assert.ok(layer.getStats().count > 0);

  clock += 11 * 60 * 1000; // past EVENT_MEMORY_MS
  assert.equal(layer.getStats().count, 0, 'old events age out of the pool');
  layer.destroy();
});
