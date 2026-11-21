import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import {
  claimPointer,
  releasePointer,
  resetPointerOwnership,
} from '../../data/inputOwnership.js';
import { createDeviceSweepLayer } from './index.js';
import {
  createGlobePlacePicker,
  groundPointAt,
  parseCoordinates,
} from './place.js';
import { createDeviceSweepStore, DEVICE_SWEEP_STORAGE_KEY } from './store.js';

// ---- typed coordinates ----------------------------------------------------

test('typed coordinates read latitude first, in either decimal notation', () => {
  assert.deepEqual(parseCoordinates('48.8566, 2.3522'), {
    lat: 48.8566,
    lon: 2.3522,
  });
  assert.deepEqual(parseCoordinates('  -33.9 ; 151.2  '), {
    lat: -33.9,
    lon: 151.2,
  });
  // A French or Spanish keyboard types a decimal comma; the separator is then
  // the space or the comma between the numbers, never inside one of them.
  assert.deepEqual(parseCoordinates('48,8566 2,3522'), {
    lat: 48.8566,
    lon: 2.3522,
  });
  assert.deepEqual(parseCoordinates('48,8566, 2,3522'), {
    lat: 48.8566,
    lon: 2.3522,
  });
  assert.deepEqual(parseCoordinates('+51.5 -0.12'), {
    lat: 51.5,
    lon: -0.12,
  });
});

test('anything that is not one pair of coordinates is refused, not guessed', () => {
  for (const text of [
    '',
    null,
    'home',
    '48.8566',
    '48.8566, 2.3522, 3',
    '91, 0',
    '-90.5, 0',
    '0, 181',
    '0, -180.5',
    '48.8566,',
  ])
    assert.equal(parseCoordinates(text), null, String(text));
  // The Gulf of Guinea is a real place: a typed 0,0 is kept.
  assert.deepEqual(parseCoordinates('0, 0'), { lat: 0, lon: 0 });
});

// ---- globe click ---------------------------------------------------------

function pickerViewer(pick) {
  return {
    camera: { pickEllipsoid: pick },
    scene: { canvas: {}, globe: { ellipsoid: Cesium.Ellipsoid.WGS84 } },
  };
}

function handlerDouble(actions, destroyed) {
  return (canvas) => ({
    setInputAction(fn, type) {
      actions.push({ fn, type, canvas });
    },
    destroy() {
      destroyed.push(canvas);
    },
  });
}

test('a globe click lands as degrees, and the handler is gone afterwards', () => {
  resetPointerOwnership();
  const actions = [];
  const destroyed = [];
  const picked = [];
  const missed = [];
  const picker = createGlobePlacePicker({
    getViewer: () =>
      pickerViewer(() => Cesium.Cartesian3.fromDegrees(2.35, 48.86)),
    onPick: (place) => picked.push(place),
    onMiss: () => missed.push(true),
    handlerFactory: handlerDouble(actions, destroyed),
  });

  assert.equal(picker.isArmed(), false);
  assert.equal(picker.arm(), true);
  assert.equal(picker.isArmed(), true);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  actions[0].fn({ position: { x: 10, y: 20 } });
  assert.equal(picked.length, 1);
  assert.ok(Math.abs(picked[0].lat - 48.86) < 1e-9);
  assert.ok(Math.abs(picked[0].lon - 2.35) < 1e-9);
  assert.equal(missed.length, 0);
  assert.equal(picker.isArmed(), false, 'one click is one place');
  assert.equal(destroyed.length, 1);
});

test('a click on the sky reports itself and leaves the picker armed', () => {
  resetPointerOwnership();
  const actions = [];
  const picked = [];
  const missed = [];
  const picker = createGlobePlacePicker({
    getViewer: () => pickerViewer(() => undefined),
    onPick: (place) => picked.push(place),
    onMiss: () => missed.push(true),
    handlerFactory: handlerDouble(actions, []),
  });

  picker.arm();
  actions[0].fn({ position: { x: 0, y: 0 } });
  assert.equal(picked.length, 0);
  assert.equal(missed.length, 1);
  assert.equal(picker.isArmed(), true);

  picker.disarm();
  assert.equal(picker.isArmed(), false);
});

test('a click another tool owns places nothing and does not consume the pick', () => {
  resetPointerOwnership();
  const actions = [];
  const picked = [];
  const picker = createGlobePlacePicker({
    getViewer: () =>
      pickerViewer(() => Cesium.Cartesian3.fromDegrees(2.35, 48.86)),
    onPick: (place) => picked.push(place),
    handlerFactory: handlerDouble(actions, []),
  });

  picker.arm();
  const lease = claimPointer('draw');
  try {
    actions[0].fn({ position: { x: 1, y: 1 } });
  } finally {
    releasePointer(lease);
    resetPointerOwnership();
  }
  assert.equal(picked.length, 0);
  assert.equal(picker.isArmed(), true);
});

test('a viewer with no canvas cannot be armed', () => {
  resetPointerOwnership();
  const picker = createGlobePlacePicker({
    getViewer: () => ({ camera: {}, scene: {} }),
    onPick: () => {},
  });
  assert.equal(picker.arm(), false);
  assert.equal(picker.isArmed(), false);
});

test('groundPointAt answers degrees for a hit and null for a miss', () => {
  const hit = groundPointAt(
    pickerViewer(() => Cesium.Cartesian3.fromDegrees(-0.12, 51.5)),
    { x: 3, y: 4 },
  );
  assert.ok(Math.abs(hit.lat - 51.5) < 1e-9);
  assert.ok(Math.abs(hit.lon + 0.12) < 1e-9);
  assert.equal(
    groundPointAt(
      pickerViewer(() => null),
      { x: 0, y: 0 },
    ),
    null,
  );
  assert.equal(groundPointAt({ scene: {} }, { x: 0, y: 0 }), null);
});

// ---- the layer's own row -------------------------------------------------

function storageDouble() {
  const saved = new Map();
  return {
    saved,
    getItem: (key) => (saved.has(key) ? saved.get(key) : null),
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key),
  };
}

function fakeViewer() {
  const primitives = [];
  return {
    camera: {
      moveEnd: new Cesium.Event(),
      changed: new Cesium.Event(),
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(2.3, 48.83, 2.38, 48.88),
    },
    scene: {
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      requestRender() {},
      primitives: {
        add(value) {
          primitives.push(value);
          return value;
        },
        remove(value) {
          const index = primitives.indexOf(value);
          if (index >= 0) primitives.splice(index, 1);
        },
      },
    },
  };
}

function layerHarness() {
  const storage = storageDouble();
  const store = createDeviceSweepStore({ storage, now: () => 10 });
  const hooks = {};
  const calls = { arm: 0, disarm: 0 };
  const layer = createDeviceSweepLayer({
    store,
    locate: async () => ({ lat: 51.5, lon: -0.12 }),
    placePickerFactory: (given) => {
      Object.assign(hooks, given);
      return {
        arm() {
          calls.arm += 1;
          return true;
        },
        disarm() {
          calls.disarm += 1;
        },
      };
    },
  });
  layer.init(fakeViewer());
  layer.enable();
  // The row hands the layer its reload; a chip click needs it.
  layer.getRowControls();
  return { layer, storage, store, hooks, calls };
}

const chip = (layer, id) =>
  layer.getRowControls().chips.find((entry) => entry.id === id);

const storedPlace = (storage) =>
  JSON.parse(storage.saved.get(DEVICE_SWEEP_STORAGE_KEY)).place;

test('the row offers a globe click and coordinates beside MY LOCATION', () => {
  const { layer } = layerHarness();
  assert.deepEqual(
    layer.getRowControls().chips.map(({ id }) => id),
    [
      'import',
      'place',
      'place-pick',
      'place-coordinates',
      'only-new',
      'note',
      'clear',
    ],
  );
  layer.destroy();
});

test('a globe click and MY LOCATION write the same stored place', async () => {
  const h = layerHarness();

  chip(h.layer, 'place-pick').onClick();
  assert.equal(h.calls.arm, 1);
  assert.equal(chip(h.layer, 'place-pick').label, 'CANCEL PICK');
  assert.equal(chip(h.layer, 'place-pick').active, true);

  h.hooks.onPick({ lat: 48.86, lon: 2.35 });
  assert.deepEqual(storedPlace(h.storage), { lat: 48.86, lon: 2.35 });
  assert.equal(chip(h.layer, 'place-pick').label, 'PICK ON GLOBE');
  assert.equal(chip(h.layer, 'place-pick').active, false);

  chip(h.layer, 'place').onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(storedPlace(h.storage), { lat: 51.5, lon: -0.12 });
  h.layer.destroy();
});

test('the pick chip cancels an armed click, and turning the layer off drops it', () => {
  const h = layerHarness();

  chip(h.layer, 'place-pick').onClick();
  assert.equal(h.calls.arm, 1);
  chip(h.layer, 'place-pick').onClick();
  assert.equal(h.calls.disarm, 1);
  assert.equal(chip(h.layer, 'place-pick').active, false);

  chip(h.layer, 'place-pick').onClick();
  assert.equal(h.calls.arm, 2);
  h.layer.disable();
  assert.equal(h.calls.disarm, 2);
  assert.equal(chip(h.layer, 'place-pick').active, false);
  h.layer.destroy();
});
