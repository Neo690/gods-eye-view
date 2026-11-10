// The Sentinel spider: patrol geometry, the watch pass, the robot body, the
// report card and the layer's lifecycle — walked end to end, with the clock,
// the document and the relay all replaced by seams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  AI_AGENT_LAYER_ID,
  ALERT_READ_BASE_MS,
  ALERT_READ_MAX_MS,
  alertReadMs,
  createAiAgentLayer,
} from './index.js';
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
  orbPulseGeometry,
  spiderSpriteFrames,
  PULSE_INTENSITY,
  SPIDER_NOTE_ID,
  SPIDER_NOTE_SOURCE,
  SPIDER_SPRITE_FRAMES,
  SPIDER_SPRITE_SIZE,
  syncSpiderNoteOverlay,
} from './spider.js';
import { getWorldOverlayDiagnostics } from '../../overlays/worldOverlay.js';
// The real application adapter: the note path is proven against the actual
// world-overlay host, not a mock of it.
import { overlayHost } from '../../app/layers/overlayHost.js';
import { setLocale } from '../../i18n/index.js';

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

test('the orb pulse cycles through the sprite frames', () => {
  assert.ok(SPIDER_SPRITE_FRAMES >= 2);
  // The pulse is a pure cycle: frame N + total lands on frame N.
  for (let frame = 0; frame < 4; frame++) {
    const first = orbPulseGeometry(frame, 4);
    const wrapped = orbPulseGeometry(frame + 4, 4);
    assert.ok(Math.abs(first.haloRadius - wrapped.haloRadius) < 1e-9);
    assert.ok(Math.abs(first.haloAlpha - wrapped.haloAlpha) < 1e-9);
  }
  // A breathe, not a blink: the calm frame and the peak differ, but softly —
  // the amplitude grows with the intensity dial and nothing more.
  const calm = orbPulseGeometry(0, 4);
  const peak = orbPulseGeometry(2, 4);
  assert.notEqual(calm.haloRadius, peak.haloRadius);
  assert.ok(peak.haloRadius - calm.haloRadius <= 18 * Math.max(1, PULSE_INTENSITY) + 0.001);
  // Headless: no canvas means no frames, never a throw.
  assert.deepEqual(spiderSpriteFrames({ doc: undefined }), []);
});

test('the orb pulse rises to one peak and settles', () => {
  const frames = [0, 1, 2, 3].map((f) => orbPulseGeometry(f, 4));
  // The glow widens to the peak (frame 2) then narrows back out.
  assert.ok(frames[1].haloRadius > frames[0].haloRadius);
  assert.ok(frames[2].haloRadius > frames[1].haloRadius);
  assert.ok(frames[3].haloRadius < frames[2].haloRadius);
  // The cosine breathes symmetrically: the fall matches the rise exactly.
  assert.ok(Math.abs(frames[1].haloRadius - frames[3].haloRadius) < 1e-9);
  // The whole sprite stays on the canvas: nothing clips off the 96-px box,
  // whatever the intensity dial is set to.
  for (const frame of frames) {
    // The 1.2 hem factor is the widest stroke the drawing pass may paint.
    assert.ok(frame.haloRadius * 1.2 <= SPIDER_SPRITE_SIZE / 2);
    assert.ok(frame.coreRadius > 0 && frame.coreRadius <= 8);
  }
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

test('GhostMaps alerts are toured most severe first, with the card open', async () => {
  const doc = fakeDocument();
  let clock = 1_500_000;
  const flights = [];
  let cancelled = 0;
  const viewer = {
    camera: {
      positionCartographic: {
        latitude: 0,
        longitude: 0,
        height: 2_000_000,
      },
      flyTo(options) {
        flights.push(options);
      },
      cancelFlight() {
        cancelled += 1;
      },
    },
    scene: { preUpdate: new Cesium.Event() },
  };
  const alerts = [
    {
      id: 'cip:1',
      product: 'cip',
      index: 1,
      name: 'MassStabbing',
      folder: 'Syria',
      lonDeg: 0.2,
      latDeg: 0.2,
      score: 540,
      severity: 'emergency',
      summary: 'MassStabbing · 11 killed',
    },
    {
      id: 'cip:2',
      product: 'cip',
      index: 2,
      name: 'Vandalism',
      folder: 'Iraq',
      lonDeg: 0.4,
      latDeg: 0.4,
      score: 20,
      severity: 'info',
      summary: 'Vandalism',
    },
  ];
  const inspected = [];
  const cleared = [];
  const ghostMaps = {
    getStats: () => ({ count: alerts.length, commit: 'edition-a' }),
    getSentinelAlerts: () => alerts,
    inspectSentinelAlert: (id) => {
      inspected.push(id);
      return true;
    },
    clearSentinelInspection: (id) => {
      cleared.push(id);
      return true;
    },
  };
  const manager = {
    getAll: () => [
      {
        id: 's2-ghostmaps',
        name: 'S2 GhostMaps',
        enabled: true,
        stats: { count: alerts.length, error: null },
      },
    ],
    layers: new Map([
      ['s2-ghostmaps', { enabled: true, module: ghostMaps }],
    ]),
  };
  // The device synthesiser, as the page supplies it: this is the real wiring
  // (voice.js) rather than a stub of the layer's own announcement path.
  const spoken = [];
  globalThis.speechSynthesis = {
    speak: (utterance) => spoken.push(utterance),
    cancel() {},
  };
  globalThis.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  const layer = createAiAgentLayer({
    docScope: doc,
    now: () => clock,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  layer.attachDataManager(manager);
  layer.init(viewer);
  layer.enable();

  // The first target is the severe one, and the view flew to it.
  let stats = layer.getStats();
  assert.equal(stats.target, 's2-ghostmaps');
  assert.equal(stats.targetKind, 'ghostmaps-alert');
  assert.equal(stats.alert, 'cip:1');
  assert.equal(flights.length, 1);
  assert.equal(flights[0].duration, 2.5);

  // Walk in, open the card, then let the scan close it.
  for (let i = 0; i < 40 && inspected.length === 0; i++) {
    clock += 250;
    viewer.scene.preUpdate.raiseEvent();
  }
  assert.equal(inspected[0], 'cip:1');
  // The tour says the alert it just reached, once.
  assert.equal(spoken.length, 1, 'the alert is said aloud');
  assert.equal(spoken[0].text, 'MassStabbing · 11 killed');
  const feed = doc.body.children[0].querySelector('.gev-ai-agent-feed');
  assert.ok(
    feed.children.some((row) =>
      /MassStabbing · 11 killed/.test(row.textContent),
    ),
    'the alert detail reaches the report card',
  );
  // The VOICE chip is on by default and mutes the announcements.
  const voiceChip = () =>
    layer.getRowControls().chips.find((chip) => chip.id === 'voice');
  assert.equal(voiceChip().active, true, 'the voice starts on');
  voiceChip().onClick();
  assert.equal(layer.getStats().voice, false);
  assert.equal(voiceChip().active, false);
  for (let i = 0; i < 80 && cleared.length === 0; i++) {
    clock += 250;
    viewer.scene.preUpdate.raiseEvent();
  }
  assert.equal(cleared[0], 'cip:1');
  assert.equal(layer.getStats().alertsVisited, 1);
  // The scan ends with a wide shot, before the tour picks its next alert.
  assert.equal(flights.length, 2);
  assert.ok(flights[1].duration < flights[0].duration);
  const pullbackHeight = Cesium.Cartographic.fromCartesian(
    flights[1].destination,
  ).height;
  assert.ok(
    pullbackHeight > 5_000_000,
    `pullback should leave the regional view (got ${pullbackHeight} m)`,
  );
  assert.equal(layer.getStats().alert, null);

  // The wide pause expires and the tour flies to the next alert.
  for (let i = 0; i < 80 && flights.length < 3; i++) {
    clock += 250;
    viewer.scene.preUpdate.raiseEvent();
  }
  stats = layer.getStats();
  assert.equal(stats.alert, 'cip:2');
  assert.equal(flights.length, 3);
  assert.equal(flights[2].duration, 2.5);
  const nextHeight = Cesium.Cartographic.fromCartesian(
    flights[2].destination,
  ).height;
  assert.ok(nextHeight <= 1_500_000, 'the next alert is framed close again');

  // Disabling mid-scan closes the card this layer opened, not a manual one.
  for (let i = 0; i < 40 && inspected.length < 2; i++) {
    clock += 250;
    viewer.scene.preUpdate.raiseEvent();
  }
  assert.equal(inspected[1], 'cip:2');
  assert.equal(spoken.length, 1, 'a muted voice says nothing');
  delete globalThis.speechSynthesis;
  delete globalThis.SpeechSynthesisUtterance;
  layer.disable();
  assert.ok(cancelled >= 1, 'disabling stops the alert flight');
  assert.equal(cleared.at(-1), 'cip:2', 'disable clears its open card');
  layer.destroy();
});

test('the tour can be held and picked up where it stopped', async () => {
  const doc = fakeDocument();
  let clock = 3_000_000;
  const flights = [];
  const viewer = {
    camera: {
      positionCartographic: {
        latitude: 0,
        longitude: 0,
        height: 2_000_000,
      },
      flyTo(options) {
        flights.push(options);
      },
      cancelFlight() {},
    },
    scene: { preUpdate: new Cesium.Event() },
  };
  const alerts = [
    {
      id: 'cip:1',
      name: 'MassStabbing',
      lonDeg: 0.2,
      latDeg: 0.2,
      score: 540,
      severity: 'emergency',
      summary: 'MassStabbing · 11 killed',
    },
  ];
  const inspected = [];
  const cleared = [];
  const ghostMaps = {
    getStats: () => ({ count: alerts.length, commit: 'edition-a' }),
    getSentinelAlerts: () => alerts,
    inspectSentinelAlert: (id) => {
      inspected.push(id);
      return true;
    },
    clearSentinelInspection: (id) => {
      cleared.push(id);
      return true;
    },
  };
  const layer = createAiAgentLayer({
    docScope: doc,
    now: () => clock,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  layer.attachDataManager({
    getAll: () => [
      {
        id: 's2-ghostmaps',
        name: 'S2 GhostMaps',
        enabled: true,
        stats: { count: alerts.length, error: null },
      },
    ],
    layers: new Map([['s2-ghostmaps', { enabled: true, module: ghostMaps }]]),
  });
  layer.init(viewer);
  layer.enable();

  // The row offers the hold, and the tour is running.
  const pauseChip = () =>
    layer.getRowControls().chips.find((chip) => chip.id === 'pause-tour');
  assert.equal(pauseChip().active, false);
  assert.equal(pauseChip().label, 'PAUSE TOUR');
  assert.equal(layer.getStats().paused, false);

  // Walk in and open the alert's card.
  for (let i = 0; i < 40 && inspected.length === 0; i++) {
    clock += 250;
    viewer.scene.preUpdate.raiseEvent();
  }
  assert.equal(inspected[0], 'cip:1');
  const held = {
    latDeg: layer.getStats().latDeg,
    lonDeg: layer.getStats().lonDeg,
  };
  const flightsAtPause = flights.length;

  // A hold freezes the walk, the camera and the reading countdown.
  pauseChip().onClick();
  assert.equal(layer.getStats().paused, true);
  assert.equal(pauseChip().active, true);
  assert.equal(pauseChip().label, 'RESUME TOUR');
  for (let i = 0; i < 80; i++) {
    clock += 250;
    viewer.scene.preUpdate.raiseEvent();
  }
  assert.equal(layer.getStats().latDeg, held.latDeg);
  assert.equal(layer.getStats().lonDeg, held.lonDeg);
  assert.equal(flights.length, flightsAtPause, 'a held tour takes no flight');
  assert.deepEqual(cleared, [], 'a held card stays open past its read time');
  assert.equal(layer.getStats().alert, 'cip:1');
  const feed = doc.body.children[0].querySelector('.gev-ai-agent-feed');
  assert.ok(
    feed.children.some((row) => /MassStabbing · 11 killed/.test(row.textContent)),
    'the card is still readable while held',
  );

  // Resuming keeps the scan's remaining time instead of restarting it. A
  // headline of this length holds the card ~10.8 s (alertReadMs), so the walk
  // gives it a full reading window.
  pauseChip().onClick();
  assert.equal(layer.getStats().paused, false);
  for (let i = 0; i < 80 && cleared.length === 0; i++) {
    clock += 250;
    viewer.scene.preUpdate.raiseEvent();
  }
  assert.deepEqual(cleared, ['cip:1'], 'the scan ends once its time is spent');
  assert.equal(layer.getStats().alertsVisited, 1);
  assert.ok(flights.length > flightsAtPause, 'the pullback follows the scan');
  layer.disable();
  layer.destroy();
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

test('alert reading time follows the headline, with a floor and a ceiling', () => {
  assert.equal(alertReadMs(''), ALERT_READ_BASE_MS);
  const short = alertReadMs('Vandalism');
  const long = alertReadMs('MassStabbing · 11 killed, 40 wounded in the market');
  assert.ok(long > short, 'a longer headline is held longer');
  assert.equal(alertReadMs('x'.repeat(400)), ALERT_READ_MAX_MS);
});

test('a new GhostMaps edition does not replay the alerts already read', async () => {
  const doc = fakeDocument();
  let clock = 4_000_000;
  const viewer = {
    camera: {
      positionCartographic: { latitude: 0, longitude: 0, height: 2_000_000 },
      flyTo() {},
      cancelFlight() {},
    },
    scene: { preUpdate: new Cesium.Event() },
  };
  const alerts = [
    {
      id: 'cip:1',
      name: 'MassStabbing',
      lonDeg: 0.2,
      latDeg: 0.2,
      score: 540,
      severity: 'emergency',
      summary: 'MassStabbing · 11 killed',
    },
    {
      id: 'cip:2',
      name: 'Shelling',
      lonDeg: 0.4,
      latDeg: 0.4,
      score: 300,
      severity: 'warn',
      summary: 'Shelling · 4 wounded',
    },
    {
      id: 'cip:3',
      name: 'Vandalism',
      lonDeg: 0.6,
      latDeg: 0.6,
      score: 20,
      severity: 'info',
      summary: 'Vandalism',
    },
  ];
  const inspected = [];
  let edition = 'edition-a';
  const ghostMaps = {
    getStats: () => ({ count: alerts.length, commit: edition }),
    getSentinelAlerts: () => alerts,
    inspectSentinelAlert: (id) => {
      inspected.push(id);
      return true;
    },
    clearSentinelInspection: () => true,
  };
  const layer = createAiAgentLayer({
    docScope: doc,
    now: () => clock,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  layer.attachDataManager({
    getAll: () => [
      {
        id: 's2-ghostmaps',
        name: 'S2 GhostMaps',
        enabled: true,
        stats: { count: alerts.length, error: null },
      },
    ],
    layers: new Map([['s2-ghostmaps', { enabled: true, module: ghostMaps }]]),
  });
  layer.init(viewer);
  layer.enable();
  const walk = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      clock += 250;
      viewer.scene.preUpdate.raiseEvent();
    }
  };
  walk(40);
  assert.equal(inspected[0], 'cip:1');

  // The source publishes a new edition while the first alert is being read:
  // the visited book must survive it, or the tour restarts at cip:1 forever.
  edition = 'edition-b';
  walk(220);
  assert.deepEqual(
    inspected.slice(0, 2),
    ['cip:1', 'cip:2'],
    'the tour resumes at the next alert, not the same one',
  );
  assert.equal(
    inspected.filter((id) => id === 'cip:1').length,
    1,
    'the first alert is read once, not replayed',
  );
  layer.destroy();
});

// ---------------------------------------------------------------------------
// ASK mode
// ---------------------------------------------------------------------------

test('ASK mode hears a held question and answers it from the loaded alerts', () => {
  const doc = fakeDocument();
  const clock = 1_500_000;
  const viewer = {
    camera: {
      positionCartographic: {
        latitude: 0,
        longitude: 0,
        height: 2_000_000,
      },
      flyTo() {},
      cancelFlight() {},
    },
    scene: { preUpdate: new Cesium.Event() },
  };
  const alerts = [
    {
      id: 'cip:1',
      product: 'cip',
      index: 1,
      name: 'MassStabbing',
      folder: 'Syria',
      lonDeg: 0.2,
      latDeg: 0.2,
      score: 540,
      severity: 'emergency',
      summary: 'MassStabbing · 11 killed',
    },
    {
      id: 'cip:2',
      product: 'cip',
      index: 2,
      name: 'MissileStrike',
      folder: 'Ukraine',
      lonDeg: 0.4,
      latDeg: 0.4,
      score: 420,
      severity: 'emergency',
      summary: 'MissileStrike · 2 killed',
    },
  ];
  const ghostMaps = {
    getStats: () => ({ count: alerts.length, commit: 'edition-a' }),
    getSentinelAlerts: () => alerts,
    inspectSentinelAlert: () => true,
    clearSentinelInspection: () => true,
  };
  const manager = {
    getAll: () => [
      {
        id: 's2-ghostmaps',
        name: 'S2 GhostMaps',
        enabled: true,
        stats: { count: alerts.length, error: null },
      },
    ],
    layers: new Map([['s2-ghostmaps', { enabled: true, module: ghostMaps }]]),
  };
  // The speaker and the microphone are seams here: the real voice has its own
  // suite, and the real input is driveable only through a phone.
  const spoken = [];
  const voice = {
    isEnabled: () => true,
    announce: (text) => {
      spoken.push(text);
      return true;
    },
    stop() {},
    setEnabled() {},
  };
  const mic = {
    available: true,
    starts: 0,
    stops: 0,
    cancels: 0,
    destroyed: false,
    handlers: null,
    start() {
      mic.starts += 1;
      return true;
    },
    stop() {
      mic.stops += 1;
      return true;
    },
    cancel() {
      mic.cancels += 1;
    },
    destroy() {
      mic.destroyed = true;
    },
  };
  setLocale('en');
  const layer = createAiAgentLayer({
    docScope: doc,
    now: () => clock,
    voice,
    askMic: (handlers) => {
      mic.handlers = handlers;
      return mic;
    },
  });
  layer.attachDataManager(manager);
  layer.init(viewer);
  layer.enable();

  const root = doc.body.children[0];
  const askButton = root.querySelector('.gev-ai-agent-ask');
  const answerLine = root.querySelector('.gev-ai-agent-answer');
  const askChip = () =>
    layer.getRowControls().chips.find((chip) => chip.id === 'ask');

  assert.equal(askChip().active, false, 'the mode starts off');
  assert.equal(askButton.hidden, true, 'no microphone before the mode is on');
  assert.equal(answerLine.hidden, true);
  assert.equal(layer.ask('the most severe'), null, 'a question needs the mode');

  askChip().onClick();
  assert.equal(layer.getStats().ask, true);
  assert.equal(askChip().active, true);
  assert.equal(askButton.hidden, false, 'the mode shows the microphone');

  // Press, hear a question, release: one local answer, said once.
  askButton.listeners.pointerdown[0]({ preventDefault() {}, pointerId: 7 });
  assert.equal(mic.starts, 1);
  mic.handlers.onTranscript('the most severe');
  assert.equal(
    layer.getStats().askAnswer,
    // The alert sits in open water, so the answer has coordinates only — the
    // country pack is warmed by switching the mode on, never waited for.
    'Most severe: MassStabbing · 11 killed · Syria · 0.200° N, 0.200° E',
  );
  assert.deepEqual(spoken, [layer.getStats().askAnswer]);
  assert.equal(answerLine.textContent, layer.getStats().askAnswer);
  assert.equal(answerLine.hidden, false, 'the reply is readable too');

  mic.handlers.onTranscript('the next one');
  assert.match(layer.getStats().askAnswer, /^Next: MissileStrike/);
  askButton.listeners.pointerup[0]({ preventDefault() {} });
  assert.equal(mic.stops, 1, 'the release closes the microphone');

  // A question outside the four gets the menu, not an invented alert.
  mic.handlers.onTranscript('bonjour');
  assert.match(layer.getStats().askAnswer, /most severe alert/i);

  // Switching the layer off closes the microphone and hides the reply.
  layer.disable();
  assert.equal(layer.getStats().ask, false);
  assert.ok(mic.cancels >= 1);
  assert.equal(askButton.hidden, true);
  assert.equal(answerLine.hidden, true);
  layer.destroy();
  assert.equal(mic.destroyed, true);
});

test('ASK mode keeps the tour silent so an answer is never cut in half', () => {
  const doc = fakeDocument();
  let clock = 1_500_000;
  const viewer = {
    camera: {
      positionCartographic: {
        latitude: 0,
        longitude: 0,
        height: 2_000_000,
      },
      flyTo() {},
      cancelFlight() {},
    },
    scene: { preUpdate: new Cesium.Event() },
  };
  const alerts = [
    {
      id: 'cip:1',
      name: 'MassStabbing',
      folder: 'Syria',
      lonDeg: 0.2,
      latDeg: 0.2,
      score: 540,
      severity: 'emergency',
      summary: 'MassStabbing · 11 killed',
    },
  ];
  const ghostMaps = {
    getStats: () => ({ count: 1, commit: 'edition-a' }),
    getSentinelAlerts: () => alerts,
    inspectSentinelAlert: () => true,
    clearSentinelInspection: () => true,
  };
  const manager = {
    getAll: () => [
      {
        id: 's2-ghostmaps',
        name: 'S2 GhostMaps',
        enabled: true,
        stats: { count: 1, error: null },
      },
    ],
    layers: new Map([['s2-ghostmaps', { enabled: true, module: ghostMaps }]]),
  };
  const spoken = [];
  const voice = {
    isEnabled: () => true,
    announce: (text) => {
      spoken.push(text);
      return true;
    },
    stop() {},
    setEnabled() {},
  };
  const mic = {
    available: true,
    handlers: null,
    start: () => true,
    stop: () => true,
    cancel() {},
    destroy() {},
  };
  const layer = createAiAgentLayer({
    docScope: doc,
    now: () => clock,
    voice,
    askMic: (handlers) => {
      mic.handlers = handlers;
      return mic;
    },
  });
  layer.attachDataManager(manager);
  layer.init(viewer);
  layer.enable();

  layer
    .getRowControls()
    .chips.find((chip) => chip.id === 'ask')
    .onClick();
  // Walk the tour into the alert with the mode on: the card still opens, the
  // speaker stays clear for the question.
  for (let i = 0; i < 40; i++) {
    clock += 250;
    viewer.scene.preUpdate.raiseEvent();
  }
  assert.deepEqual(spoken, [], 'the tour does not narrate in ASK mode');

  mic.handlers.onTranscript('la plus grave');
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /^Most severe: MassStabbing/);
  layer.destroy();
});
