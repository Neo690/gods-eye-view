import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  DEVICE_ENTITY_ID,
  ZOOM_STEP_RATIO,
  bindMapViewControls,
  flyToFix,
  readFix,
  zoomBy,
} from './mapViewControls.js';

class FakeButton extends EventTarget {
  constructor() {
    super();
    this.attributes = new Map();
    this.disabled = false;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name);
  }
  click() {
    this.dispatchEvent(new Event('click'));
  }
}

function createViewer({ height = 1_000_000 } = {}) {
  const calls = [];
  const entities = [];
  const moveEndListeners = new Set();
  const viewer = {
    camera: {
      positionCartographic: { height },
      pitch: -0.96,
      heading: 0,
      cancelFlight: () => calls.push(['cancelFlight']),
      zoomIn: (distance) => calls.push(['zoomIn', distance]),
      zoomOut: (distance) => calls.push(['zoomOut', distance]),
      flyTo: (options) => calls.push(['flyTo', options]),
      setView: (view) => calls.push(['setView', view]),
      // The operator moving the map, as Cesium reports it.
      moveEnd: {
        addEventListener: (listener) => moveEndListeners.add(listener),
        removeEventListener: (listener) => moveEndListeners.delete(listener),
      },
    },
    scene: { requestRender: () => calls.push(['requestRender']) },
    entities: {
      add: (entity) => {
        entities.push(entity);
        return entity;
      },
      remove: (entity) => {
        const at = entities.indexOf(entity);
        if (at >= 0) entities.splice(at, 1);
      },
    },
  };
  const operatorMoves = () => {
    for (const listener of moveEndListeners) listener();
  };
  return { viewer, calls, entities, operatorMoves, moveEndListeners };
}

function createGeolocation() {
  const stepped = { watch: null, watches: [], cleared: [], next: 6 };
  return {
    stepped,
    watchPosition(success, error, options) {
      stepped.next += 1;
      stepped.watch = { success, error, options, id: stepped.next };
      stepped.watches.push(stepped.watch);
      return stepped.watch.id;
    },
    clearWatch(id) {
      stepped.cleared.push(id);
    },
  };
}

function createControls(options = {}) {
  const { viewer, calls, entities, operatorMoves } = createViewer(options);
  const elements = {
    zoomIn: new FakeButton(),
    zoomOut: new FakeButton(),
    locate: new FakeButton(),
  };
  const toasts = [];
  const geolocation = options.geolocation || createGeolocation();
  const controls = bindMapViewControls({
    viewer,
    elements,
    showToast: (text) => toasts.push(text),
    geolocation,
  });
  return {
    viewer,
    calls,
    entities,
    elements,
    toasts,
    geolocation,
    controls,
    operatorMoves,
  };
}

test('readFix keeps a real fix and drops the null-island one', () => {
  const fix = readFix({
    coords: { latitude: 48.8566, longitude: 2.3522, accuracy: 12 },
  });
  assert.equal(fix.lat, 48.8566);
  assert.equal(fix.lon, 2.3522);
  assert.equal(fix.accuracy, 12);
  const back = Cesium.Cartographic.fromCartesian(fix.cartesian);
  assert.ok(Math.abs(Cesium.Math.toDegrees(back.latitude) - 48.8566) < 1e-6);
  assert.ok(Math.abs(Cesium.Math.toDegrees(back.longitude) - 2.3522) < 1e-6);

  // A cold GPS reports (0, 0); it must not put the view in the Gulf of Guinea.
  assert.equal(readFix({ coords: { latitude: 0, longitude: 0 } }), null);
  assert.equal(readFix({ coords: { latitude: NaN, longitude: 2 } }), null);
  assert.equal(readFix(null), null);

  // A missing accuracy still rings the marker, at a sane radius.
  assert.equal(readFix({ coords: { latitude: 1, longitude: 1 } }).accuracy, 25);
});

test('zoom steps from the current height, in and out', () => {
  const { viewer, calls } = createViewer({ height: 1_000_000 });
  assert.equal(zoomBy(viewer, 'in'), true);
  assert.deepEqual(calls[0], ['cancelFlight']);
  assert.deepEqual(calls[1], ['zoomIn', 1_000_000 * ZOOM_STEP_RATIO]);
  assert.deepEqual(calls[2], ['requestRender']);

  calls.length = 0;
  assert.equal(zoomBy(viewer, 'out'), true);
  assert.deepEqual(calls[1], ['zoomOut', 1_000_000 * ZOOM_STEP_RATIO]);

  // At street level the step keeps its floor rather than collapsing to nothing.
  const close = createViewer({ height: 10 });
  zoomBy(close.viewer, 'in');
  assert.deepEqual(close.calls[1], ['zoomIn', 12]);

  assert.equal(zoomBy({}, 'in'), false);
});

test('a flight the render loop never advances still lands the view', async () => {
  const calls = [];
  const viewer = {
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1_500_000),
      flyTo: (options) => calls.push(['flyTo', options]),
      cancelFlight: () => calls.push(['cancelFlight']),
      setView: (options) => calls.push(['setView', options]),
    },
    scene: { requestRender: () => calls.push(['requestRender']) },
  };
  const fix = readFix({
    coords: { latitude: 45.764, longitude: 4.8357, accuracy: 12 },
  });
  assert.equal(flyToFix(viewer, fix, { settleDelayMs: 20 }), true);
  assert.equal(calls[0][0], 'flyTo');
  await new Promise((resolve) => setTimeout(resolve, 80));
  // The fake camera never moved, so the settle step places it outright.
  assert.deepEqual(
    calls.map(([name]) => name),
    ['flyTo', 'cancelFlight', 'setView', 'requestRender'],
  );
  const placed = Cesium.Cartographic.fromCartesian(calls[2][1].destination);
  assert.ok(Math.abs(Cesium.Math.toDegrees(placed.latitude) - 45.764) < 0.01);
});

test('a completed flight is not overridden by the settle step', async () => {
  const calls = [];
  const viewer = {
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-97.74, 30.27, 1_500_000),
      flyTo: (options) => {
        calls.push(['flyTo', options]);
        // The animation finished before the check runs.
        viewer.camera.positionWC = Cesium.Cartesian3.clone(options.destination);
      },
      cancelFlight: () => calls.push(['cancelFlight']),
      setView: () => calls.push(['setView']),
    },
    scene: { requestRender: () => calls.push(['requestRender']) },
  };
  flyToFix(
    viewer,
    readFix({ coords: { latitude: 45.764, longitude: 4.8357 } }),
    { settleDelayMs: 20 },
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(
    calls.map(([name]) => name),
    ['flyTo'],
  );
});

test('the locate button toggles a watch, flies once and marks the device', () => {
  const context = createControls();
  const { elements, calls, entities, toasts, geolocation } = context;

  // Unpressed and named for what it will do.
  assert.equal(elements.locate.getAttribute('aria-pressed'), 'false');
  assert.equal(
    elements.locate.getAttribute('aria-label'),
    'Centre on my position',
  );

  elements.locate.click();
  // Asking for the fix marks the button as waiting, but it stays tappable so
  // that a second press can cancel the watch.
  assert.equal(elements.locate.getAttribute('aria-busy'), 'true');
  assert.equal(geolocation.stepped.watch.options.enableHighAccuracy, true);

  geolocation.stepped.watch.success({
    coords: { latitude: 48.8566, longitude: 2.3522, accuracy: 15 },
  });
  assert.equal(elements.locate.getAttribute('aria-busy'), 'false');
  assert.equal(elements.locate.getAttribute('aria-pressed'), 'true');
  assert.equal(
    elements.locate.getAttribute('aria-label'),
    'Stop following your position',
  );
  assert.equal(entities.length, 1);
  assert.equal(entities[0].id, DEVICE_ENTITY_ID);
  const flight = calls.find(([name]) => name === 'flyTo');
  assert.ok(flight, 'the first fix flies the camera');
  assert.deepEqual(toasts, ['Following your position']);

  // Later fixes carry the camera too — a vehicle under the crosshair — while
  // the marker follows on its own.
  calls.length = 0;
  geolocation.stepped.watch.success({
    coords: { latitude: 48.86, longitude: 2.36, accuracy: 20 },
  });
  assert.equal(
    calls.some(([name]) => name === 'flyTo'),
    false,
    'a second fix must not restart a flight',
  );
  const follow = calls.find(([name]) => name === 'setView');
  assert.ok(follow, 'the camera rides along with the fix');
  assert.equal(entities.length, 1);

  elements.locate.click();
  assert.deepEqual(geolocation.stepped.cleared, [7]);
  assert.equal(entities.length, 0);
  assert.equal(elements.locate.getAttribute('aria-pressed'), 'false');
});

test('panning releases the camera, and the button recentres without dropping the watch', () => {
  const { elements, calls, entities, geolocation, operatorMoves } =
    createControls();
  elements.locate.click();
  geolocation.stepped.watch.success({
    coords: { latitude: 48.8566, longitude: 2.3522, accuracy: 15 },
  });
  assert.equal(elements.locate.getAttribute('aria-pressed'), 'true');

  // Cesium reports the end of our own flight first; the pan is the next one.
  operatorMoves();
  assert.equal(elements.locate.getAttribute('aria-pressed'), 'true');
  operatorMoves();
  assert.equal(elements.locate.getAttribute('aria-pressed'), 'false');
  assert.equal(
    geolocation.stepped.cleared.length,
    0,
    'the watch keeps running: only the camera is released',
  );
  assert.equal(entities.length, 1);

  // A fix still moves the dot, and no longer the camera.
  calls.length = 0;
  geolocation.stepped.watch.success({
    coords: { latitude: 48.87, longitude: 2.37, accuracy: 15 },
  });
  assert.equal(
    calls.some(([name]) => name === 'setView'),
    false,
    'a released camera stays where the operator put it',
  );

  // Pressing again recentres on the device and rides along once more.
  calls.length = 0;
  elements.locate.click();
  assert.equal(elements.locate.getAttribute('aria-pressed'), 'true');
  assert.ok(calls.some(([name]) => name === 'flyTo'), 'the press recentres');
  calls.length = 0;
  geolocation.stepped.watch.success({
    coords: { latitude: 48.88, longitude: 2.38, accuracy: 15 },
  });
  assert.ok(calls.some(([name]) => name === 'setView'));
});

test('a stationary fix does not redraw the camera', () => {
  const { elements, calls, geolocation } = createControls();
  elements.locate.click();
  geolocation.stepped.watch.success({
    coords: { latitude: 48.8566, longitude: 2.3522, accuracy: 15 },
  });
  calls.length = 0;
  geolocation.stepped.watch.success({
    coords: { latitude: 48.8566, longitude: 2.3522, accuracy: 15 },
  });
  assert.equal(calls.some(([name]) => name === 'setView'), false);
});

test('the injected flight is what a first fix asks for', () => {
  const { viewer, elements, geolocation, entities } = createControls();
  const flown = [];
  const controls = bindMapViewControls({
    viewer,
    elements,
    geolocation,
    flyTo: (fix) => flown.push(fix),
  });
  elements.locate.click();
  geolocation.stepped.watch.success({
    coords: { latitude: 45.764, longitude: 4.8357, accuracy: 20 },
  });
  assert.equal(flown.length, 1);
  assert.equal(flown[0].lat, 45.764);
  assert.equal(flown[0].lon, 4.8357);
  assert.equal(entities.length, 1);
  controls.destroy();
});

test('a permission refusal reports the block and does not retry', () => {
  const { elements, toasts, geolocation, entities } = createControls();
  elements.locate.click();
  geolocation.stepped.watch.error({ code: 1 });
  assert.deepEqual(toasts, ['Location access is blocked for this app.']);
  assert.equal(elements.locate.getAttribute('aria-pressed'), 'false');
  assert.equal(elements.locate.getAttribute('aria-busy'), 'false');
  assert.deepEqual(geolocation.stepped.cleared, [7]);
  assert.equal(geolocation.stepped.watches.length, 1);
  assert.equal(entities.length, 0);
});

test('no satellite fix falls back to the network provider', () => {
  const { elements, toasts, geolocation, entities, calls } = createControls();
  elements.locate.click();
  assert.equal(geolocation.stepped.watch.options.enableHighAccuracy, true);

  // Indoors: GNSS never answers, so the precise watch times out.
  geolocation.stepped.watch.error({ code: 3 });
  assert.equal(geolocation.stepped.watches.length, 2);
  const retry = geolocation.stepped.watches[1];
  assert.equal(retry.options.enableHighAccuracy, false);
  assert.deepEqual(geolocation.stepped.cleared, [7]);
  // Still armed, not failed: the request is simply less precise now.
  assert.equal(elements.locate.getAttribute('aria-pressed'), 'true');
  assert.equal(elements.locate.getAttribute('aria-busy'), 'true');
  assert.deepEqual(toasts, []);

  retry.success({
    coords: { latitude: 45.764, longitude: 4.8357, accuracy: 900 },
  });
  assert.equal(entities.length, 1);
  assert.equal(calls.filter(([name]) => name === 'flyTo').length, 1);
  assert.deepEqual(toasts, ['Following your position']);
});

test('the network provider failing too is the one that reports unavailable', () => {
  const { elements, toasts, geolocation } = createControls();
  elements.locate.click();
  geolocation.stepped.watch.error({ code: 2 });
  geolocation.stepped.watch.error({ code: 3 });
  assert.deepEqual(toasts, ['Location unavailable']);
  assert.equal(elements.locate.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(geolocation.stepped.cleared, [7, 8]);
});

test('a device with no geolocation says so instead of arming a watch', () => {
  const { viewer } = createViewer();
  const elements = { locate: new FakeButton() };
  const toasts = [];
  bindMapViewControls({
    viewer,
    elements,
    showToast: (text) => toasts.push(text),
    geolocation: undefined,
  });
  elements.locate.click();
  assert.deepEqual(toasts, ['This device has no location access.']);
  assert.equal(elements.locate.getAttribute('aria-pressed'), 'false');
});

test('destroy stops the watch and clears the marker', () => {
  const { elements, geolocation, entities, controls } = createControls();
  elements.locate.click();
  geolocation.stepped.watch.success({
    coords: { latitude: 35.6762, longitude: 139.6503, accuracy: 10 },
  });
  assert.equal(entities.length, 1);
  controls.destroy();
  assert.equal(entities.length, 0);
  assert.deepEqual(geolocation.stepped.cleared, [7]);
  assert.equal(elements.locate.getAttribute('aria-pressed'), 'false');
});
