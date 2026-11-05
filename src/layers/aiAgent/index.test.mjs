// The Sentinel spider: patrol geometry, the watch pass, the robot body, the
// report card and the layer's lifecycle — walked end to end, with the clock,
// the document and the relay all replaced by seams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { AI_AGENT_LAYER_ID, createAiAgentLayer } from './index.js';
import {
  angularDistance,
  destinationPoint,
  rankInspectionTargets,
  stepPatrol,
  wrapLongitude,
  ARRIVE_RAD,
  SCAN_MS,
} from './patrol.js';
import { eventSeverity, watchLayers, worstSeverity } from './watch.js';
import { createAvatarOverlay } from './overlay.js';
import {
  createSpiderBody,
  destroySpiderNoteOverlay,
  spiderLegPose,
  spiderSpriteFrames,
  SPIDER_NOTE_ID,
  SPIDER_NOTE_SOURCE,
  SPIDER_SPRITE_FRAMES,
  syncSpiderNoteOverlay,
} from './spider.js';
import { getWorldOverlayDiagnostics } from '../../overlays/worldOverlay.js';
// The real application adapter: the note path is proven against the actual
// world-overlay host, not a mock of it.
import { overlayHost } from '../../app/layers/overlayHost.js';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// A very small DOM: enough for the report card (create, append, prepend,
// remove, class, attribute, hidden, click), and nothing else.
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.textContent = '';
    this.parentNode = null;
    this.classList = {
      toggle: (name, force) => {
        const on = force === undefined ? !this.hasClass(name) : Boolean(force);
        this.className = on
          ? [...new Set([...this.classNames(), name])].join(' ')
          : this.classNames()
              .filter((value) => value !== name)
              .join(' ');
        return on;
      },
      contains: (name) => this.hasClass(name),
    };
  }

  // Read-only in a browser: `element.dataset = {}` throws a TypeError there,
  // and a double that accepted it once hid exactly that bug.
  get dataset() {
    return (this._dataset ??= {});
  }

  // One class store behind both spellings, as in the DOM: `className` for
  // HTML and the `class` attribute a translated markup pass also writes.
  get className() {
    return this.attributes.class ?? '';
  }

  set className(value) {
    this.attributes.class = String(value);
  }

  classNames() {
    return this.className.split(/\s+/).filter(Boolean);
  }

  hasClass(name) {
    return this.classNames().includes(name);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  prepend(child) {
    child.parentNode = this;
    this.children.unshift(child);
    return child;
  }

  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    parent.children = parent.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }

  click() {
    for (const handler of this.listeners.click ?? []) handler({});
  }

  get childElementCount() {
    return this.children.length;
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] ?? null;
  }

  querySelector(selector) {
    const wanted = selector.startsWith('.') ? selector.slice(1) : null;
    if (!wanted) return null;
    const walk = (node) => {
      for (const child of node.children) {
        if (child.hasClass(wanted)) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }

  querySelectorAll(selector) {
    const wanted = selector.startsWith('.') ? selector.slice(1) : null;
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (wanted && child.hasClass(wanted)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

// An SVG node: `className` is a read-only SVGAnimatedString there, so the
// double refuses the assignment a real browser throws on.
class FakeSvgElement extends FakeElement {
  get className() {
    return this.attributes.class ?? '';
  }

  set className(_value) {
    throw new TypeError(
      'Cannot set property className of #<SVGElement> which has only a getter',
    );
  }
}

function fakeCanvas() {
  const context = {
    clearRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    ellipse() {},
    stroke() {},
    fill() {},
    lineCap: 'round',
    lineJoin: 'round',
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
  };
  const canvas = new FakeElement('canvas');
  canvas.getContext = () => context;
  canvas.toDataURL = () => 'data:image/png;base64,AA==';
  canvas.width = 0;
  canvas.height = 0;
  return canvas;
}

function fakeDocument() {
  const body = new FakeElement('body');
  return {
    body,
    createElement: (tag) =>
      tag === 'canvas' ? fakeCanvas() : new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeSvgElement(tag),
  };
}

// ---------------------------------------------------------------------------
// Patrol geometry
// ---------------------------------------------------------------------------

test('angularDistance reads a quarter turn and folds the dateline', () => {
  const quarter = angularDistance(
    { latDeg: 0, lonDeg: 0 },
    { latDeg: 0, lonDeg: 90 },
  );
  assert.ok(Math.abs(quarter - Math.PI / 2) < 1e-9);
  const across = angularDistance(
    { latDeg: 0, lonDeg: 179 },
    { latDeg: 0, lonDeg: -179 },
  );
  assert.ok(Math.abs(across - 2 * DEG) < 1e-9);
  assert.equal(
    destinationPoint({ latDeg: 0, lonDeg: 179 }, 90 * DEG, 2 * DEG).lonDeg,
    -179,
  );
  assert.equal(wrapLongitude(190), -170);
});

test('stepPatrol walks an arc, turns toward the target and lands exactly', () => {
  const here = { latDeg: 0, lonDeg: 0, headingRad: 0 };
  const target = { latDeg: 0, lonDeg: 10 };
  const first = stepPatrol(here, target, 0.1);
  assert.equal(first.arrived, false);
  assert.ok(first.travelledRad > 0);
  // Facing north while the target is east: the turn is bounded, not instant,
  // so one short step swings the body only part of the way round.
  assert.ok(first.headingRad > 0);
  assert.ok(first.headingRad < 20 * DEG);

  let state = first;
  let steps = 0;
  while (!state.arrived && steps < 400) {
    state = stepPatrol(state, target, 0.25);
    steps += 1;
  }
  assert.equal(state.arrived, true);
  assert.equal(state.latDeg, target.latDeg);
  assert.equal(state.lonDeg, target.lonDeg);
  assert.ok(steps < 400);

  // Already there: one step reports arrival without moving.
  const atTarget = stepPatrol(
    { latDeg: 0, lonDeg: 0, headingRad: 0 },
    { latDeg: 0, lonDeg: ARRIVE_RAD / DEG / 2 },
    1,
  );
  assert.equal(atTarget.arrived, true);
});

test('rankInspectionTargets prefers severity, then health, then nearness', () => {
  const from = { latDeg: 0, lonDeg: 0 };
  const ranked = rankInspectionTargets(
    [
      { layerId: 'near-info', latDeg: 0, lonDeg: 1 },
      {
        layerId: 'far-emergency',
        latDeg: 0,
        lonDeg: 60,
        severity: 'emergency',
      },
      { layerId: 'broken', latDeg: 0, lonDeg: 40, error: true },
      { layerId: 'no-position', latDeg: null, lonDeg: null },
    ],
    { from, now: 1_000_000 },
  );
  assert.deepEqual(
    ranked.map((entry) => entry.layerId),
    ['far-emergency', 'broken', 'near-info'],
  );
  assert.ok(ranked.every((entry) => Number.isFinite(entry.score)));

  // Reproducible: the same inputs always rank the same way.
  const again = rankInspectionTargets(
    [
      { layerId: 'near-info', latDeg: 0, lonDeg: 1 },
      {
        layerId: 'far-emergency',
        latDeg: 0,
        lonDeg: 60,
        severity: 'emergency',
      },
    ],
    { from, now: 1_000_000 },
  );
  assert.equal(again[0].layerId, 'far-emergency');
});

test('a layer the spider is already on does not win by default', () => {
  const ranked = rankInspectionTargets(
    [
      { layerId: 'underfoot', latDeg: 0, lonDeg: 0.01 },
      { layerId: 'next-door', latDeg: 0, lonDeg: 6 },
    ],
    { from: { latDeg: 0, lonDeg: 0 }, now: 5_000, current: 'underfoot' },
  );
  assert.equal(ranked[0].layerId, 'next-door');
});

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

test('watchLayers arms the baseline, then reports errors and count moves', () => {
  const rows = [
    {
      id: 'flights',
      name: 'Live Flights',
      enabled: true,
      stats: { count: 10 },
    },
  ];
  const state = { previous: null, seen: new Set() };
  const arm = watchLayers(rows, state, { now: () => 1000 });
  assert.equal(arm.events.length, 0, 'first sight is not news');
  state.previous = arm.previous;

  const broken = watchLayers(
    [
      {
        id: 'flights',
        name: 'Live Flights',
        enabled: true,
        stats: { count: 10, sourceUnavailable: true, error: 'upstream 503' },
      },
    ],
    state,
    { now: () => 2000 },
  );
  assert.equal(broken.events.length, 1);
  assert.equal(broken.events[0].kind, 'layer-error');
  assert.equal(eventSeverity(broken.events[0]), 'warn');
  state.previous = broken.previous;

  const moved = watchLayers(
    [
      {
        id: 'flights',
        name: 'Live Flights',
        enabled: true,
        stats: { count: 14, sourceUnavailable: true, error: 'upstream 503' },
      },
    ],
    state,
    { now: () => 3000 },
  );
  assert.equal(moved.events.length, 1);
  assert.equal(moved.events[0].kind, 'event-update');
  assert.equal(moved.events[0].detail, '+4');
  assert.equal(worstSeverity(moved.events), 'info');
});

test('a loading tick carries no news', () => {
  const state = {
    previous: null,
    seen: new Set(['flights']),
  };
  watchLayers(
    [
      {
        id: 'flights',
        name: 'Live Flights',
        stats: { count: 4, loading: true },
      },
    ],
    state,
    { now: () => 1000 },
  );
  const tick = watchLayers(
    [
      {
        id: 'flights',
        name: 'Live Flights',
        stats: { count: 9, loading: true },
      },
    ],
    state,
    { now: () => 2000 },
  );
  assert.equal(tick.events.length, 0);
});

// ---------------------------------------------------------------------------
// The robot body
// ---------------------------------------------------------------------------

test('the gait cycles over the sprite frames', () => {
  assert.ok(SPIDER_SPRITE_FRAMES >= 2);
  // The learned gait is a pure cycle: frame N + total lands on frame N.
  for (let leg = 0; leg < 8; leg++) {
    const first = spiderLegPose(0, 4, leg);
    const wrapped = spiderLegPose(4, 4, leg);
    assert.ok(Math.abs(first.swing - wrapped.swing) < 1e-9);
    assert.ok(Math.abs(first.knee - wrapped.knee) < 1e-9);
    assert.notEqual(spiderLegPose(1, 4, leg).swing, first.swing);
  }
  // Headless: no canvas means no frames, never a throw.
  assert.deepEqual(spiderSpriteFrames({ doc: undefined }), []);
});

test('the learned walk is not a mirrored leg pair any more', () => {
  // The analytic gait cancelled exactly every frame; the learned one does
  // not — the two front legs lift at different phases of the cycle.
  let unwrap = 0;
  for (let f = 0; f < 4; f++) {
    const left = spiderLegPose(f, 4, 0).swing;
    const right = spiderLegPose(f, 4, 1).swing;
    if (Math.abs(left + right) > 0.3) unwrap += 1;
  }
  assert.ok(unwrap > 0);
});

/** A Cesium stand-in: enough of the API the spider body touches. */
function fakeCesium() {
  class CallbackProperty {
    constructor(callback, isConstant) {
      this.callback = callback;
      this.isConstant = isConstant;
    }
    getValue() {
      return this.callback();
    }
  }
  class CustomDataSource {
    constructor(name) {
      this.name = name;
      this.entities = {
        items: [],
        add: (definition) => {
          this.entities.items.push(definition);
          return definition;
        },
      };
    }
  }
  function Cartesian3() {
    this.x = 1;
  }
  Cartesian3.fromDegrees = (lon, lat, height) => ({ lon, lat, height });
  Cartesian3.normalize = () => ({ x: 1, y: 0, z: 0 });
  class Color {
    constructor(css, alpha = 1) {
      this.css = css;
      this.alpha = alpha;
    }
    withAlpha(alpha) {
      return new Color(this.css, alpha);
    }
  }
  Color.fromCssColorString = (css) => new Color(css);
  class Cartesian2 {
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }
  }
  class NearFarScalar {
    constructor() {}
  }
  class ColorMaterialProperty {
    constructor(color) {
      this.color = color;
    }
  }
  return {
    CallbackProperty,
    CustomDataSource,
    Cartesian2,
    Cartesian3,
    Color,
    NearFarScalar,
    ColorMaterialProperty,
  };
}

test('createSpiderBody rides the state object and leaves nothing behind', () => {
  const CesiumFake = fakeCesium();
  const added = [];
  const removed = [];
  const viewer = {
    dataSources: {
      add: (source) => {
        added.push(source);
        return Promise.resolve(source);
      },
      remove: (source) => {
        removed.push(source);
        return Promise.resolve(true);
      },
    },
  };
  const state = {
    latDeg: 12,
    lonDeg: 34,
    headingRad: 1.2,
    frame: 0,
    visible: true,
    scanning: true,
    ringRadiusM: 250000,
    note: 'Live Flights',
    severity: 'warn',
  };
  const frames = ['data:frame-0', 'data:frame-1'];
  const body = createSpiderBody({
    viewer,
    state,
    frames,
    cesium: CesiumFake,
  });
  assert.ok(body);
  assert.equal(added.length, 1);
  const { billboard } = body.entity;
  assert.equal(billboard.image.getValue(), 'data:frame-0');
  assert.equal(billboard.rotation.getValue(), 1.2);
  // The inspection note is NOT an entity label graphic (noCesiumLabels); it
  // rides the world-overlay host through syncSpiderNoteOverlay.
  assert.equal(body.entity.label, undefined);
  assert.equal(body.ring.ellipse.semiMajorAxis.getValue(), 250000);
  state.frame = 1;
  state.visible = false;
  state.scanning = false;
  assert.equal(billboard.image.getValue(), 'data:frame-1');
  assert.equal(body.ring.show.getValue(), false);

  body.destroy();
  assert.equal(removed.length, 1);
});

test('createSpiderBody degrades without a scene instead of throwing', () => {
  assert.equal(createSpiderBody({ viewer: {}, state: {} }), null);
  assert.equal(createSpiderBody({}), null);
});

test('the inspection note rides the world-overlay host, never an entity label', () => {
  destroySpiderNoteOverlay(overlayHost);
  syncSpiderNoteOverlay({
    state: {
      note: 'Live Flights',
      severity: 'warn',
      latDeg: 12,
      lonDeg: 34,
    },
    host: overlayHost,
  });
  const withEntry = getWorldOverlayDiagnostics();
  assert.equal(withEntry.entriesBySource[SPIDER_NOTE_SOURCE], 1);

  // Moving on clears the caption instead of drawing an empty one.
  syncSpiderNoteOverlay({ state: { note: '', latDeg: 12, lonDeg: 34 }, host: overlayHost });
  const cleared = getWorldOverlayDiagnostics();
  assert.equal(cleared.entriesBySource[SPIDER_NOTE_SOURCE] ?? 0, 0);

  syncSpiderNoteOverlay({ state: { note: 'Cyclones', severity: 'emergency' }, host: overlayHost });
  syncSpiderNoteOverlay({ state: { note: '   ', severity: 'info' }, host: overlayHost });
  assert.equal(
    getWorldOverlayDiagnostics().entriesBySource[SPIDER_NOTE_SOURCE] ?? 0,
    0,
    'a blank note is not a caption',
  );

  destroySpiderNoteOverlay(overlayHost);
});

test('a note source that never existed removes without creating one', () => {
  destroySpiderNoteOverlay(overlayHost);
  assert.doesNotThrow(() => syncSpiderNoteOverlay({ state: {}, host: overlayHost }));
  assert.equal(
    getWorldOverlayDiagnostics().entriesBySource[SPIDER_NOTE_SOURCE] ?? 0,
    0,
  );
  assert.ok(SPIDER_NOTE_ID);
});

// A layer built without an injected host simply has no note: it neither
// creates nor destroys an overlay source.
test('without an overlay host the note path is a no-op', () => {
  destroySpiderNoteOverlay();
  syncSpiderNoteOverlay({ state: { note: 'Cyclones', severity: 'warn' } });
  assert.equal(
    getWorldOverlayDiagnostics().entriesBySource[SPIDER_NOTE_SOURCE] ?? 0,
    0,
  );
  destroySpiderNoteOverlay(overlayHost);
});

// ---------------------------------------------------------------------------
// The report card
// ---------------------------------------------------------------------------

test('the card mounts, expands on click and lists what the spider read', () => {
  const doc = fakeDocument();
  const card = createAvatarOverlay({ doc });
  const root = doc.body.children[0];
  assert.ok(root.hasClass('gev-ai-agent'));
  assert.equal(root.getAttribute('data-state'), 'idle');
  assert.equal(card.visible, true);

  card.setState('warn');
  assert.equal(root.getAttribute('data-state'), 'alert');

  card.pushEvent({
    layerId: 'flights',
    label: 'Live Flights',
    detail: '128 records',
    at: Date.now(),
    severity: 'info',
  });
  const feed = root.querySelector('.gev-ai-agent-feed');
  const bubble = root.querySelector('.gev-ai-agent-bubble');
  assert.equal(feed.childElementCount, 1);
  assert.match(feed.children[0].textContent, /Live Flights — 128 records/);
  assert.equal(feed.hidden, true, 'collapsed until the operator opens it');
  assert.equal(bubble.hidden, true);

  root.querySelector('.gev-ai-agent-toggle').click();
  assert.equal(feed.hidden, false);
  assert.equal(bubble.hidden, false);

  card.setSleeping(true);
  assert.equal(root.hasClass('asleep'), true);
  assert.equal(feed.hidden, true, 'a sleeping spider closes its card');

  card.destroy();
  assert.equal(doc.body.children.length, 0);
  assert.equal(card.visible, false);
});

test('the card keeps only the newest findings', () => {
  const doc = fakeDocument();
  const card = createAvatarOverlay({ doc });
  const feed = doc.body.children[0].querySelector('.gev-ai-agent-feed');
  for (let i = 0; i < 20; i++) {
    card.pushEvent({
      layerId: 'flights',
      label: 'Live Flights',
      detail: `${i}`,
      at: Date.now(),
      severity: 'info',
    });
  }
  assert.equal(feed.childElementCount, 12);
  assert.match(feed.children[0].textContent, /Live Flights — 19/);
  card.destroy();
});

test('a document-less run gets no card at all', () => {
  assert.equal(createAvatarOverlay({ doc: null, host: null }), null);
});

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

function fakeViewer({ latDeg = 0, lonDeg = 0 } = {}) {
  return {
    camera: {
      positionCartographic: { latitude: latDeg * DEG, longitude: lonDeg * DEG },
      setView() {
        throw new Error('the spider must never move the camera');
      },
    },
    scene: { preUpdate: new Cesium.Event() },
  };
}

/** One managed layer whose reader holds a single positioned record. */
function fakeManager(rows) {
  const manager = {
    rows,
    getAll: () => manager.rows,
    layers: new Map([
      [
        'flights',
        {
          module: {
            getAllPositions: () => [{ latitude: 0.2, longitude: 0.2 }],
          },
        },
      ],
    ]),
  };
  return manager;
}

test('the spider walks to an enabled layer and reports what it holds', async () => {
  const doc = fakeDocument();
  const viewer = fakeViewer({ latDeg: 0, lonDeg: 0 });
  let clock = 1_000_000;
  const layer = createAiAgentLayer({
    docScope: doc,
    now: () => clock,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  const manager = fakeManager([
    {
      id: 'flights',
      name: 'Live Flights',
      enabled: true,
      stats: { count: 5, loading: false, error: null },
    },
  ]);
  layer.attachDataManager(manager);
  assert.equal(layer.init(viewer), true);
  assert.equal(layer.enable(), true);
  assert.equal(
    layer.getStats().mode,
    'watchdog',
    'no scene container, no body',
  );

  // Walk the frames: the body turns toward the record and lands on it.
  for (let i = 0; i < 40; i++) {
    clock += 250;
    viewer.scene.preUpdate.raiseEvent();
  }
  const feed = doc.body.children[0].querySelector('.gev-ai-agent-feed');
  assert.ok(feed.childElementCount >= 1, 'the inspection reached the card');
  assert.match(feed.children[0].textContent, /Live Flights — 5 records/);

  // The scan holds, then the spider rests before choosing again.
  for (let i = 0; i < 40; i++) {
    clock += 250;
    viewer.scene.preUpdate.raiseEvent();
  }
  assert.ok(SCAN_MS > 0);
  assert.equal(layer.disable(), true);
  assert.equal(layer.destroy(), true);
  assert.equal(doc.body.children.length, 0);
});

test('a feed that breaks diverts the spider and words one brief', async () => {
  const doc = fakeDocument();
  const viewer = fakeViewer();
  let clock = 2_000_000;
  const relay = [];
  const layer = createAiAgentLayer({
    docScope: doc,
    now: () => clock,
    fetchImpl: async (url, request) => {
      relay.push({ url, request });
      return {
        ok: true,
        status: 200,
        json: async () => ({ plan: { speech: 'Barometer feed is down.' } }),
      };
    },
  });
  const manager = fakeManager([
    {
      id: 'flights',
      name: 'Live Flights',
      enabled: true,
      stats: { count: 5, loading: false, error: null },
    },
  ]);
  layer.attachDataManager(manager);
  layer.init(viewer);
  layer.enable(); // arms the watchdog baseline

  manager.rows = [
    {
      id: 'flights',
      name: 'Live Flights',
      enabled: true,
      stats: {
        count: 5,
        loading: false,
        sourceUnavailable: true,
        error: '503',
      },
    },
  ];
  clock += 30_000;
  await layer.update();
  const card = doc.body.children[0];
  assert.equal(card.getAttribute('data-state'), 'alert');

  for (let i = 0; i < 40; i++) {
    clock += 250;
    viewer.scene.preUpdate.raiseEvent();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(relay.length, 1, 'one sentence, one request');
  assert.equal(relay[0].url, '/api/openai/agent-plan');
  const feed = card.querySelector('.gev-ai-agent-feed');
  assert.ok(
    feed.children.some((row) =>
      /Barometer feed is down\./.test(row.textContent),
    ),
    'the brief lands in the same feed as the deterministic findings',
  );

  // The next warning inside the window spends nothing.
  clock += 30_000;
  manager.rows = [
    {
      id: 'flights',
      name: 'Live Flights',
      enabled: true,
      stats: {
        count: 5,
        loading: false,
        sourceUnavailable: true,
        error: '503',
      },
    },
  ];
  await layer.update();
  for (let i = 0; i < 40; i++) {
    clock += 250;
    viewer.scene.preUpdate.raiseEvent();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(relay.length, 1, 'the twenty-minute cap holds');

  layer.destroy();
});

test('a keyless relay leaves the deterministic finding untouched', async () => {
  const doc = fakeDocument();
  const viewer = fakeViewer();
  let clock = 3_000_000;
  const layer = createAiAgentLayer({
    docScope: doc,
    now: () => clock,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  layer.attachDataManager(
    fakeManager([
      {
        id: 'flights',
        name: 'Live Flights',
        enabled: true,
        stats: { count: 7, loading: false, error: null },
      },
    ]),
  );
  layer.init(viewer);
  layer.enable();
  for (let i = 0; i < 40; i++) {
    clock += 250;
    viewer.scene.preUpdate.raiseEvent();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  const feed = doc.body.children[0].querySelector('.gev-ai-agent-feed');
  assert.match(feed.children[0].textContent, /Live Flights — 7 records/);
  layer.destroy();
});

test('the layer refuses a second init and never claims a count it lacks', () => {
  const layer = createAiAgentLayer({ docScope: null, now: () => 0 });
  assert.equal(layer.id, AI_AGENT_LAYER_ID);
  layer.attachDataManager(fakeManager([]));
  const viewer = fakeViewer();
  assert.equal(layer.init(viewer), true);
  assert.throws(() => layer.init(viewer), /already initialized/);
  const stats = layer.getStats();
  assert.equal(stats.loading, false);
  assert.equal(stats.count, 0);
  assert.ok(stats.emptyHint.includes('Sentinel'));
  layer.enable();
  layer.disable();
  layer.destroy();
});
