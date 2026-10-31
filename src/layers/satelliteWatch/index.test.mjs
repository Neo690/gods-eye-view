import test from 'node:test';
import assert from 'node:assert/strict';
import { createSatelliteWatchLayer } from './index.js';
import { WATCH_SOURCES } from './model.js';
import { parseTleCatalog } from '../orbitChanges/model.js';

/** Parsed the way the source parses it: the comparison reads `elements`. */
const ISS = Object.freeze(
  parseTleCatalog(
    [
      'ISS (ZARYA)',
      '1 25544U 98067A   24001.50000000  .00016717  00000+0  30777-3 0  9993',
      '2 25544  51.6416  90.5085 0004526  90.7038  51.2835 15.49512600  1234',
    ].join('\n'),
  )[0],
);

/** The same object as the proxy cache held before its last refresh: lower. */
const ISS_PREVIOUS = Object.freeze(
  parseTleCatalog(
    [
      'ISS (ZARYA)',
      '1 25544U 98067A   24000.25000000  .00016717  00000+0  30777-3 0  9993',
      '2 25544  51.6416  90.5085 0004526  90.7038  51.2835 15.48000000  1234',
    ].join('\n'),
  )[0],
);

/** The secondary of the live feed's conjunctions: debris, never in a group. */
const DEBRIS = Object.freeze(
  parseTleCatalog(
    [
      'COSMOS 2251 DEB',
      '1 47311U 93036ACB 24001.50000000  .00001234  00000-0  35000-3 0  9994',
      '2 47311  74.0500  12.3456 0012345 100.0000 260.0000 14.90000000  1234',
    ].join('\n'),
  )[0],
);

const N2YO_ROW = Object.freeze({
  satid: 25544,
  satname: 'ISS (ZARYA)',
  satlat: 12.5,
  satlng: 34.5,
  alt: 419,
});

const recordingOverlay = () => ({
  entries: [],
  setEntries(_id, entries) {
    this.entries = entries;
  },
  setVisible() {},
  clearSource() {},
});

function harness(readers = {}, { viewer: viewerExtras = {}, ...options } = {}) {
  const calls = {
    catalog: 0,
    previous: 0,
    tle: 0,
    n2yo: 0,
    spacetrack: 0,
    elements: [],
  };
  const source = {
    readCatalog: async () => {
      calls.catalog++;
      if (readers.catalog) return readers.catalog();
      return { entries: [ISS], stale: false };
    },
    readPreviousCatalog: async () => {
      calls.previous++;
      if (readers.previous) return readers.previous();
      return { entries: [] };
    },
    readTleApi: async () => {
      calls.tle++;
      if (readers.tle) return readers.tle();
      return { members: [ISS] };
    },
    readN2yo: async () => {
      calls.n2yo++;
      if (readers.n2yo) return readers.n2yo();
      return { ok: true, error: null, above: [N2YO_ROW] };
    },
    readSpaceTrack: async () => {
      calls.spacetrack++;
      if (readers.spaceTrack) return readers.spaceTrack();
      return { ok: true, error: null, entries: [ISS], messages: [] };
    },
    readElementSets: async (norads) => {
      calls.elements.push(norads);
      if (readers.elements) return readers.elements(norads);
      return { entries: [] };
    },
  };
  const dataSources = {
    add: (dataSource) => dataSource,
    remove() {},
  };
  const viewer = {
    dataSources,
    camera: {
      positionCartographic: { latitude: 0, longitude: 0 },
    },
    ...viewerExtras,
  };
  const storage = {
    _value: null,
    _keys: new Map(),
    getItem(key) {
      return this._keys.has(key) ? this._keys.get(key) : this._value;
    },
    setItem(key, value) {
      this._value = value;
      this._keys.set(key, value);
    },
  };
  const overlay = recordingOverlay();
  const layer = createSatelliteWatchLayer({
    source,
    overlayHost: overlay,
    storage,
    now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    ...options,
  });
  layer.init(viewer);
  return { layer, calls, overlay, storage };
}

const switches = (layer) => layer.getRowControls().networks.items;
const checked = (layer) =>
  Object.fromEntries(switches(layer).map((item) => [item.id, item.checked]));

test('the row offers the four sources, all on, and one flip leaves the rest alone', async () => {
  const { layer } = harness();
  layer.enable();
  await layer.update();
  assert.deepEqual(
    switches(layer).map((item) => item.id),
    WATCH_SOURCES.map((source) => source.id),
  );
  assert.deepEqual(checked(layer), {
    azmth: true,
    'orbital-radar': true,
    'war-monitor': true,
    'space-track': true,
    n2yo: true,
  });

  const azmth = switches(layer).find((item) => item.id === 'azmth');
  azmth.onClick();
  assert.deepEqual(checked(layer), {
    azmth: false,
    'orbital-radar': true,
    'war-monitor': true,
    'space-track': true,
    n2yo: true,
  });

  const n2yo = switches(layer).find((item) => item.id === 'n2yo');
  n2yo.onClick();
  assert.equal(checked(layer).n2yo, false);
  assert.equal(checked(layer)['orbital-radar'], true);
  layer.disable();
});

test('Orbital Radar paints on the first poll from the generation the cache replaced', async () => {
  const { layer, calls, storage } = harness({
    previous: () => ({ entries: [ISS_PREVIOUS] }),
  });
  layer.enable();
  await layer.update();

  const radar = switches(layer).find((item) => item.id === 'orbital-radar');
  // The inferred change is there on the first reading, not the second.
  assert.match(radar.text, /Orbital Radar · 1/);
  assert.equal(calls.previous, 1);
  assert.doesNotMatch(radar.title, /Baseline recorded/);
  assert.ok(
    layer
      .getAnalystRecords()
      .some((row) => row.source === 'orbital-radar' && row.id === '25544'),
    'the inferred manoeuvre is queryable',
  );
  // The baseline on disk is the fresh generation, so the next poll compares
  // against this reading rather than the cached one.
  assert.ok(storage.getItem());
  layer.disable();
});

test('with no proxy cache the first poll falls back to the orbit baseline already on the device', async () => {
  const { layer, storage } = harness();
  // The Orbit Changes layer's own reading from an earlier session, kept under
  // its own key; nothing in it is consumed or cleared here.
  storage.setItem(
    'gev.orbit-baseline.v1',
    JSON.stringify({
      at: 1,
      objects: {
        25544: ISS_PREVIOUS.elements && {
          name: ISS_PREVIOUS.name,
          epochMs: ISS_PREVIOUS.epochMs,
          meanMotion: ISS_PREVIOUS.elements.meanMotion,
          inclinationDeg: ISS_PREVIOUS.elements.inclinationDeg,
          eccentricity: ISS_PREVIOUS.elements.eccentricity,
        },
      },
    }),
  );
  layer.enable();
  await layer.update();

  const radar = switches(layer).find((item) => item.id === 'orbital-radar');
  assert.match(radar.text, /Orbital Radar · 1/);
  assert.ok(
    storage.getItem('gev.orbit-baseline.v1'),
    'the other layer’s baseline is only read',
  );
  layer.disable();
});

test('with no cached generation the first poll records the baseline and says so', async () => {
  const { layer, calls } = harness();
  layer.enable();
  await layer.update();

  const radar = switches(layer).find((item) => item.id === 'orbital-radar');
  assert.equal(calls.previous, 1);
  assert.match(radar.title, /Baseline recorded/);
  layer.disable();
});

test('a dead catalogue costs its own switch, never the other sources', async () => {
  const { layer } = harness({
    catalog: () => {
      throw new Error('catalogue down');
    },
  });
  layer.enable();
  await layer.update();
  await new Promise((resolve) => setImmediate(resolve));

  const byId = Object.fromEntries(
    switches(layer).map((item) => [item.id, item]),
  );
  assert.equal(byId.azmth.checked, true);
  assert.match(byId.azmth.title, /catalogue down/);
  assert.equal(byId['war-monitor'].checked, true);
  assert.equal(byId.n2yo.checked, true);
  assert.match(byId.n2yo.title, /Shown/);
  // The N2YO answer still landed: one object, counted on its own switch.
  assert.match(byId.n2yo.text, /N2YO · 1/);
  assert.equal(layer.getStats().count > 0, true);
  layer.disable();
});

test('a Space-Track conjunction is placed at its close approach and counted', async () => {
  const { layer, overlay } = harness({
    spaceTrack: () => ({
      ok: true,
      error: null,
      entries: [ISS],
      messages: [
        {
          CDM_ID: 987654,
          TCA: '2026-01-02 00:00:00',
          SAT_1_ID: 25544,
          SAT_1_NAME: 'ISS (ZARYA)',
          SAT_2_ID: 47311,
          SAT_2_NAME: 'COSMOS 2251 DEB',
          MIN_RNG: 0.083,
          PC: 0.000856,
          RELATIVE_SPEED: 14.23,
        },
      ],
    }),
  });
  layer.enable();
  await layer.update();
  await new Promise((resolve) => setImmediate(resolve));

  const spaceTrack = switches(layer).find((item) => item.id === 'space-track');
  assert.equal(spaceTrack.checked, true);
  assert.match(spaceTrack.text, /Space-Track · 1/);
  assert.match(spaceTrack.title, /Conjunctions: 1/);
  assert.ok(
    overlay.entries.some((entry) => /COSMOS 2251 DEB/.test(entry.title)),
    'the close approach is labelled on the globe',
  );

  const conjunction = layer
    .getAnalystRecords()
    .find((row) => row.conjunctionWith === 'COSMOS 2251 DEB');
  assert.ok(conjunction, 'the conjunction is queryable');
  assert.equal(conjunction.source, 'space-track');
  assert.equal(conjunction.minRangeKm, 0.083);
  assert.ok(Number.isFinite(conjunction.lat));
  assert.ok(Number.isFinite(conjunction.lon));
  layer.disable();
});

test('a pair missing its secondary fetches that set and gets a closing rate', async () => {
  // The public feed never publishes RELATIVE_SPEED and the GP window holds no
  // debris, so without this completion every card would read "Unavailable".
  const { layer, calls } = harness({
    spaceTrack: () => ({
      ok: true,
      error: null,
      entries: [ISS],
      messages: [
        {
          CDM_ID: 987655,
          TCA: '2026-01-02 00:00:00',
          SAT_1_ID: 25544,
          SAT_1_NAME: 'ISS (ZARYA)',
          SAT_2_ID: 47311,
          SAT_2_NAME: 'COSMOS 2251 DEB',
          MIN_RNG: 0.4,
          PC: 0.0002,
        },
      ],
    }),
    elements: () => ({ entries: [DEBRIS] }),
  });
  layer.enable();
  await layer.update();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.elements, [['47311']], 'only the missing half is read');
  const conjunction = layer
    .getAnalystRecords()
    .find((row) => row.conjunctionWith === 'COSMOS 2251 DEB');
  assert.ok(conjunction, 'the conjunction is placed with the completed pair');
  assert.ok(
    Number.isFinite(conjunction.relativeSpeedKmS),
    'the closing rate comes from both element sets',
  );
  assert.equal(conjunction.relativeSpeedSource, 'elements');
  layer.disable();
});

test('clicking a conjunction opens its card, and empty space closes it', async () => {
  const cdm = {
    CDM_ID: 987654,
    TCA: '2026-01-02 00:00:00',
    SAT_1_ID: 25544,
    SAT_1_NAME: 'ISS (ZARYA)',
    SAT_2_ID: 47311,
    SAT_2_NAME: 'COSMOS 2251 DEB',
    MIN_RNG: 0.083,
    PC: 0.000856,
    RELATIVE_SPEED: 14.23,
  };
  // The pick Cesium returns for one of our marker entities is the Entity
  // itself, so the id is one level in.
  let pick = null;
  const handler = {
    fn: null,
    destroyed: 0,
    setInputAction(fn) {
      this.fn = fn;
    },
    destroy() {
      this.destroyed++;
    },
  };
  const { layer, overlay } = harness(
    {
      spaceTrack: () => ({
        ok: true,
        error: null,
        entries: [ISS],
        messages: [cdm],
      }),
    },
    {
      viewer: {
        scene: { pick: () => pick, canvas: {} },
      },
      eventHandlerFactory: () => handler,
    },
  );
  layer.enable();
  await layer.update();
  await new Promise((resolve) => setImmediate(resolve));

  const ambient = overlay.entries.find((entry) => entry.selected !== true);
  assert.ok(ambient, 'the conjunction is labelled before the click');
  assert.equal(ambient.details.length, 1);

  // A click on the marker: the card carries the five fields.
  pick = { id: { id: 'satwatch:conjunction:cdm:987654' } };
  handler.fn({ position: { x: 10, y: 20 } });
  const card = overlay.entries.find((entry) => entry.selected === true);
  assert.ok(card, 'the clicked conjunction opens its card');
  assert.equal(card.title, 'ISS (ZARYA) × COSMOS 2251 DEB');
  assert.deepEqual(card.details, [
    'NORAD 25544 × 47311',
    'Pc 8.56e-4',
    'TCA 2026-01-02 00:00Z',
    'Relative speed 14.23 km/s',
    'Source Space-Track CDM',
  ]);
  // The opened card replaces the one-line label rather than doubling it.
  assert.equal(
    overlay.entries.filter((entry) => /COSMOS 2251 DEB/.test(entry.title))
      .length,
    1,
  );

  // A click on another layer's entity leaves the card alone.
  pick = { id: { id: 'aircraft:4ca123' } };
  handler.fn({ position: { x: 10, y: 20 } });
  assert.ok(overlay.entries.some((entry) => entry.selected === true));

  // Empty space closes it.
  pick = null;
  handler.fn({ position: { x: 10, y: 20 } });
  assert.equal(
    overlay.entries.some((entry) => entry.selected === true),
    false,
    'a click on empty space closes the card',
  );
  assert.ok(
    overlay.entries.some((entry) => /COSMOS 2251 DEB/.test(entry.title)),
  );

  layer.disable();
  assert.equal(handler.destroyed, 1, 'the click handler goes with the layer');
});

test('turning a source back on fetches it now instead of waiting for the poll', async () => {
  const { layer, calls } = harness();
  layer.enable();
  await layer.update();
  assert.equal(calls.n2yo, 1);

  const n2yo = switches(layer).find((item) => item.id === 'n2yo');
  n2yo.onClick();
  assert.equal(calls.n2yo, 1, 'switching off costs no request');

  switches(layer)
    .find((item) => item.id === 'n2yo')
    .onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.n2yo, 2, 'switching on asks the source immediately');
  layer.disable();
});
