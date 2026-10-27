// Behavioral tests for the alert centre's zone rules: the panel is mounted on a
// fake DOM, driven through its own form and bell, and its observable effects are
// asserted — what reaches storage, what the next scan reports, and what the list
// shows. The rules engine and the edge detector have their own suites
// (src/data/zoneRules.test.mjs, src/data/zoneWatch.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';

import { setLocale } from '../i18n/index.js';
import { ZONE_RULES_STORAGE_KEY } from '../data/zoneRules.js';
import { mountAlertCenter } from './alertCenter.js';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const INSIDE = { lat: 43.3, lon: 5.37 };

class FakeClassList {
  constructor() {
    this.names = new Set();
  }
  add(...names) {
    for (const name of names) this.names.add(name);
  }
  remove(...names) {
    for (const name of names) this.names.delete(name);
  }
  contains(name) {
    return this.names.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : Boolean(force);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.className = '';
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.parent = null;
    this.listeners = [];
    this.hidden = false;
    this.value = '';
    this._text = '';
  }
  set textContent(value) {
    this._text = String(value ?? '');
    for (const child of this.children) child.parent = null;
    this.children = [];
  }
  get textContent() {
    return (
      this._text + this.children.map((child) => child.textContent).join('')
    );
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
  }
  addEventListener(type, listener) {
    this.listeners.push({ type, listener });
  }
  removeEventListener(type, listener) {
    this.listeners = this.listeners.filter(
      (entry) => entry.type !== type || entry.listener !== listener,
    );
  }
  /** Fire a listener the way the page would. */
  fire(type, event = {}) {
    for (const entry of this.listeners.filter((l) => l.type === type)) {
      entry.listener({ target: this, preventDefault() {}, ...event });
    }
  }
  focus() {}
  remove() {
    this.parent = null;
  }
  closest() {
    return null;
  }
  contains(node) {
    return node === this || this.children.includes(node);
  }
}

const fakeDocument = () => ({
  createElement: (tagName) => new FakeElement(tagName),
  addEventListener() {},
  removeEventListener() {},
});

const fakeStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    stored: (key) => JSON.parse(map.get(key) ?? 'null'),
  };
};

/** Depth-first search, since the panel builds its DOM behind a closure. */
function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, predicate);
    if (hit) return hit;
  }
  return null;
}

const byPlaceholder = (placeholder) => (node) =>
  node.placeholder === placeholder;

const aircraft = (overrides = {}) => ({
  icao24: 'abc123',
  callsign: 'TEST123',
  speedMps: 220,
  onGround: false,
  military: false,
  ...INSIDE,
  ...overrides,
});

const vessel = (overrides = {}) => ({
  mmsi: '227006010',
  name: 'FERRY ONE',
  speedKts: 12,
  ...INSIDE,
  ...overrides,
});

/**
 * Run `body` with timers captured instead of scheduled, so a scan happens when
 * a test says so rather than 12 s later — and so a real interval can never keep
 * the process alive.
 * @param {Array<Function>} timers
 * @param {() => unknown} body
 */
function withCapturedTimers(timers, body) {
  const real = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
  };
  globalThis.setTimeout = (callback) => timers.push(callback);
  globalThis.setInterval = (callback) => {
    timers.push(callback);
    return 0;
  };
  globalThis.clearTimeout = () => {};
  globalThis.clearInterval = () => {};
  try {
    return body();
  } finally {
    Object.assign(globalThis, real);
  }
}

/**
 * Mount the panel with deterministic timers, so a test decides when scans run.
 * @returns {object} The panel, its DOM, its storage and the captured toasts.
 */
function mount({ source = { flights: [aircraft()] }, viewCentre = null } = {}) {
  const timers = [];
  const root = new FakeElement();
  const storage = fakeStorage();
  const toasts = [];
  let current = source;
  const panel = withCapturedTimers(timers, () =>
    mountAlertCenter({
      root,
      provider: () => current,
      showToast: (text) => toasts.push(text),
      viewCentre,
      documentRef: fakeDocument(),
      storage,
      now: () => NOW,
      firstDelayMs: 0,
    }),
  );
  return {
    root,
    storage,
    toasts,
    timers,
    panel,
    setSource: (next) => {
      current = next;
    },
    /** Run the first scan, which the panel scheduled at mount. */
    firstScan: () => {
      const [fire] = timers;
      assert.equal(
        typeof fire,
        'function',
        'the panel schedules its first scan',
      );
      withCapturedTimers([], fire);
    },
  };
}

const readRules = (storage) => storage.stored(ZONE_RULES_STORAGE_KEY);

test('a zone added through the form reaches storage and the next scan reports it', () => {
  setLocale('en');
  const world = mount();
  const { root, storage } = world;

  const name = find(root, byPlaceholder('Name'));
  const radius = find(root, byPlaceholder('Radius (km)'));
  const lat = find(root, byPlaceholder('Latitude'));
  const lon = find(root, byPlaceholder('Longitude'));
  const ids = find(root, byPlaceholder('ICAO24 or MMSI, separated by spaces'));
  const kind = find(root, (node) => node.tagName === 'SELECT');
  assert.ok(
    name && radius && lat && lon && ids && kind,
    'the editor is mounted',
  );

  name.value = 'Marina';
  kind.value = 'entry';
  radius.value = '5';
  lat.value = String(INSIDE.lat);
  lon.value = String(INSIDE.lon);
  ids.value = 'abc123 227006010 not-an-id';
  find(root, (node) => node.className === 'alert-center-zone-form').fire(
    'submit',
  );

  const [rule] = readRules(storage);
  assert.equal(rule.name, 'Marina');
  assert.equal(rule.kind, 'entry');
  assert.equal(rule.radiusKm, 5);
  assert.deepEqual(rule.watch, { icao24: ['ABC123'], mmsi: ['227006010'] });
  assert.equal(rule.enabled, true);

  const note = find(
    root,
    (node) => node.className === 'alert-center-zone-error',
  );
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'Not an ICAO24 or an MMSI: not-an-id');

  // The aircraft is inside the new circle, so the next scan reports an entry.
  world.firstScan();
  assert.deepEqual(
    world.panel.rules().map((entry) => entry.name),
    ['Marina'],
  );
  const summary = find(
    root,
    (node) => node.className === 'alert-center-zones-summary',
  );
  assert.equal(summary.textContent, 'Zone rules (1)');
});

test('a zone alert is listed in the panel, named after the identifier it caught', () => {
  setLocale('en');
  const world = mount();
  const { root } = world;
  find(root, byPlaceholder('Name')).value = 'Marina';
  find(root, byPlaceholder('Latitude')).value = String(INSIDE.lat);
  find(root, byPlaceholder('Longitude')).value = String(INSIDE.lon);
  find(root, (node) => node.className === 'alert-center-zone-form').fire(
    'submit',
  );
  world.firstScan();

  // Open the list: rows only exist while the popup is open.
  find(root, (node) => node.className === 'alert-center-button').fire('click');
  const row = find(root, (node) => node.className === 'alert-center-row');
  assert.ok(row, 'the zone incident is in the list');
  const title = find(row, (node) => node.className === 'alert-center-title');
  assert.equal(title.textContent, 'Zone entry — TEST123');
  const detail = find(row, (node) => node.className === 'alert-center-detail');
  assert.equal(detail.textContent, 'Entered Marina · ABC123');
  const meta = find(row, (node) => node.className === 'alert-center-meta');
  assert.match(meta.textContent, /Live Flights$/);
});

test('a vessel is caught too, and a listed address is critical', () => {
  setLocale('en');
  const world = mount({ source: { vessels: [vessel()] } });
  const { root } = world;
  find(root, byPlaceholder('Name')).value = 'Harbour';
  find(root, byPlaceholder('Latitude')).value = String(INSIDE.lat);
  find(root, byPlaceholder('Longitude')).value = String(INSIDE.lon);
  find(root, byPlaceholder('ICAO24 or MMSI, separated by spaces')).value =
    '227006010';
  find(root, (node) => node.className === 'alert-center-zone-form').fire(
    'submit',
  );
  world.firstScan();
  find(root, (node) => node.className === 'alert-center-button').fire('click');

  const row = find(root, (node) => node.className === 'alert-center-row');
  assert.equal(row.dataset.severity, 'critical');
  const detail = find(row, (node) => node.className === 'alert-center-detail');
  assert.equal(detail.textContent, 'Entered Harbour · 227006010');
});

test('the map centre action fills the position, and a missing map says so', () => {
  setLocale('en');
  const withMap = mount({ viewCentre: () => ({ lat: 48.85, lon: 2.35 }) });
  find(withMap.root, (node) => node.textContent === 'Use the map centre').fire(
    'click',
  );
  assert.equal(find(withMap.root, byPlaceholder('Latitude')).value, '48.85');
  assert.equal(find(withMap.root, byPlaceholder('Longitude')).value, '2.35');

  const withoutMap = mount();
  const button = find(
    withoutMap.root,
    (node) => node.textContent === 'Use the map centre',
  );
  assert.equal(button.hidden, true, 'the action is hidden without a camera');
});

test('a malformed zone is refused in the active language, and nothing is stored', () => {
  setLocale('fr');
  try {
    const world = mount();
    const { root, storage } = world;
    // The panel is in French here, so the fields are found by their French
    // labels: the whole point is that the editor speaks the active language.
    find(root, byPlaceholder('Nom')).value = 'Marina';
    find(root, byPlaceholder('Latitude')).value = String(INSIDE.lat);
    find(root, byPlaceholder('Longitude')).value = String(INSIDE.lon);
    find(root, byPlaceholder('Rayon (km)')).value = '0.1';
    find(root, (node) => node.className === 'alert-center-zone-form').fire(
      'submit',
    );

    assert.equal(readRules(storage), null, 'a refused rule is not persisted');
    const note = find(
      root,
      (node) => node.className === 'alert-center-zone-error',
    );
    assert.equal(note.hidden, false);
    assert.equal(
      note.textContent,
      'Le rayon doit être compris entre 0.25 et 500 km',
    );
  } finally {
    setLocale('en');
  }
});

test('a stored zone is rendered at mount, can be disabled and removed', () => {
  setLocale('en');
  // Mount reads the rules from the storage it is given, so seed it through the
  // same fake the panel writes to: mount twice over one storage.
  const storage = fakeStorage();
  const mountOnce = () => {
    const root = new FakeElement();
    const panel = withCapturedTimers([], () =>
      mountAlertCenter({
        root,
        provider: () => ({ flights: [aircraft()] }),
        documentRef: fakeDocument(),
        storage,
        now: () => NOW,
        firstDelayMs: 0,
      }),
    );
    return { root, panel };
  };
  {
    const { root, panel } = mountOnce();
    find(root, byPlaceholder('Name')).value = 'Marina';
    find(root, byPlaceholder('Latitude')).value = String(INSIDE.lat);
    find(root, byPlaceholder('Longitude')).value = String(INSIDE.lon);
    find(root, (node) => node.className === 'alert-center-zone-form').fire(
      'submit',
    );
    panel.destroy();
  }

  {
    const { root: secondRoot, panel: secondPanel } = mountOnce();
    const root = secondRoot;
    const panel = secondPanel;
    const first = mountOnce();
    find(first.root, byPlaceholder('Name')).value = 'Marina';
    find(first.root, byPlaceholder('Latitude')).value = String(INSIDE.lat);
    find(first.root, byPlaceholder('Longitude')).value = String(INSIDE.lon);
    find(
      first.root,
      (node) => node.className === 'alert-center-zone-form',
    ).fire('submit');
    first.panel.destroy();

    const summary = find(
      root,
      (node) => node.className === 'alert-center-zones-summary',
    );
    assert.equal(summary.textContent, 'Zone rules (1)', 'the rule survived');

    const toggle = find(
      root,
      (node) => node.className === 'alert-center-zone-toggle',
    );
    toggle.checked = false;
    toggle.fire('change');
    assert.equal(readRules(storage)[0].enabled, false);
    assert.equal(
      summary.textContent,
      'Zone rules (1)',
      'a disabled rule is kept',
    );

    const disabled = find(
      root,
      (node) => node.className === 'alert-center-zone-toggle',
    );
    assert.equal(disabled.checked, false);

    find(root, (node) => node.className === 'alert-center-zone-remove').fire(
      'click',
    );
    assert.deepEqual(readRules(storage), []);
    assert.equal(summary.textContent, 'Zone rules (0)');
    panel.destroy();
  }
});
