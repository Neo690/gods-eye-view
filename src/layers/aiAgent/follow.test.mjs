// Tests for the Sentinel camera-follow module: the drift policy, every pause
// gate, and the promise that the camera's pose is never touched. The camera
// is a double; the pointer lease comes from the real inputOwnership module,
// which is also what the follow reads, so the gate tests exercise the live
// wiring.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  followStepDeg,
  shortestLongitudeDeltaDeg,
  createSpiderCameraFollow,
  FOLLOW_RATE_PER_S,
  FOLLOW_MAX_SPEED_DEG_PER_S,
  FOLLOW_RELEASE_COOLDOWN_MS,
  FOLLOW_WHEEL_COOLDOWN_MS,
} from './follow.js';
import { claimPointer, releasePointer, resetPointerOwnership } from '../../data/inputOwnership.js';

/** A camera double faithful to the fields the follow reads. */
function cameraDouble({
  lat = 20,
  lon = 0,
  height = 1_000_000,
  heading = 0,
  pitch = -Math.PI / 2,
  roll = 0,
  moving = false,
} = {}) {
  const views = [];
  return {
    views,
    moving,
    heading,
    pitch,
    roll,
    positionCartographic: {
      latitude: (lat * Math.PI) / 180,
      longitude: (lon * Math.PI) / 180,
      height,
    },
    setView(options) {
      views.push(options);
    },
  };
}

const CESIUM = {
  Math: {
    toDegrees: (rad) => (rad * 180) / Math.PI,
    toRadians: (deg) => (deg * Math.PI) / 180,
  },
  Cartesian3: {
    fromDegrees: (lon, lat, height) => ({ lon, lat, height }),
  },
};

/** A fake canvas: listens, records, and hands back events. */
function canvasDouble() {
  const bound = new Map();
  return {
    bound,
    addEventListener(type, listener, options) {
      const list = bound.get(type) ?? [];
      list.push({ listener, options });
      bound.set(type, list);
    },
    removeEventListener(type, listener, options) {
      const list = bound.get(type) ?? [];
      const at = list.findIndex(
        (entry) => entry.listener === listener && entry.options === options,
      );
      if (at >= 0) list.splice(at, 1);
      bound.set(type, list);
    },
    fire(type, event = {}) {
      for (const { listener } of bound.get(type) ?? []) listener(event);
    },
  };
}

const moduloNow = () => {
  let at = 0;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
};

test('followStepDeg converges proportionally and never overshoots', () => {
  assert.equal(followStepDeg(0, 0.016), 0, 'no remaining distance, no step');
  assert.equal(followStepDeg(10, 0), 0, 'a zero frame seconds moves nothing');
  assert.equal(
    followStepDeg(10, Number.NaN),
    0,
    'a NaN frame seconds moves nothing',
  );
  const first = followStepDeg(10, 1);
  const expected = 10 * (1 - Math.exp(-FOLLOW_RATE_PER_S));
  assert.ok(Math.abs(first - expected) < 1e-9);
  assert.ok(first < 10, 'a proportional share never overshoots');
  const capped = followStepDeg(1000, 0.5);
  assert.equal(capped, FOLLOW_MAX_SPEED_DEG_PER_S * 0.5, 'speed cap holds');
  assert.equal(
    followStepDeg(-1000, 0.5),
    -FOLLOW_MAX_SPEED_DEG_PER_S * 0.5,
    'the cap is symmetric',
  );
});

test('shortestLongitudeDeltaDeg takes the short way round the antimeridian', () => {
  assert.equal(shortestLongitudeDeltaDeg(0, 10), 10);
  assert.equal(shortestLongitudeDeltaDeg(10, 0), -10);
  assert.equal(shortestLongitudeDeltaDeg(180, -175), 5);
  assert.equal(shortestLongitudeDeltaDeg(-175, 180), -5);
  assert.equal(shortestLongitudeDeltaDeg(170, -170), 20);
  assert.equal(shortestLongitudeDeltaDeg(-170, 170), -20);
  assert.equal(shortestLongitudeDeltaDeg(Number.NaN, 10), 0);
  assert.equal(shortestLongitudeDeltaDeg(0, Number.NaN), 0);
});

test('an enabled follow drifts the sub-camera point toward the spider', () => {
  const clock = moduloNow();
  const camera = cameraDouble({ lat: 10, lon: 0, height: 500_000 });
  const follow = createSpiderCameraFollow({
    camera,
    state: { latDeg: 11, lonDeg: 2, visible: true },
    now: clock.now,
    cesium: CESIUM,
  });
  follow.setEnabled(true);
  const moved = follow.step(0.5);
  assert.equal(moved, true);
  assert.equal(camera.views.length, 1);
  const view = camera.views[0];
  const expectedLat = 10 + (11 - 10) * (1 - Math.exp(-FOLLOW_RATE_PER_S * 0.5));
  const expectedLon =
    0 + shortestLongitudeDeltaDeg(0, 2) * (1 - Math.exp(-FOLLOW_RATE_PER_S * 0.5));
  // The destination keeps the eye exactly where the drift says, and the height
  // is passed through untouched.
  assert.ok(Math.abs(view.destination.lat - expectedLat) < 1e-9);
  assert.ok(Math.abs(view.destination.lon - expectedLon) < 1e-9);
  assert.equal(view.destination.height, 500_000);
  // The pose the operator left is carried through untouched: a follow moves
  // the sub-camera point only.
  assert.equal(view.orientation.heading, camera.heading);
  assert.equal(view.orientation.pitch, camera.pitch);
  assert.equal(view.orientation.roll, camera.roll);
});

test('a converged follow stops calling setView', () => {
  const camera = cameraDouble({ lat: 11, lon: 2 });
  const follow = createSpiderCameraFollow({
    camera,
    state: { latDeg: 11, lonDeg: 2, visible: true },
    cesium: CESIUM,
  });
  follow.setEnabled(true);
  assert.equal(follow.step(1), false);
  assert.equal(camera.views.length, 0);
});

test('a disabled follow never moves the camera', () => {
  const camera = cameraDouble({ lat: 10, lon: 0 });
  const follow = createSpiderCameraFollow({
    camera,
    state: { latDeg: 30, lonDeg: 30, visible: true },
    cesium: CESIUM,
  });
  assert.equal(follow.isEnabled, false);
  assert.equal(follow.step(1), false);
  assert.equal(camera.views.length, 0);

  follow.setEnabled(true);
  assert.equal(follow.isEnabled, true);
  follow.setEnabled(false);
  assert.equal(follow.step(1), false);
  assert.equal(camera.views.length, 0);
});

test('a hidden spider stops the drift', () => {
  const camera = cameraDouble({ lat: 10, lon: 0 });
  const follow = createSpiderCameraFollow({
    camera,
    state: { latDeg: 30, lonDeg: 30, visible: false },
    cesium: CESIUM,
  });
  follow.setEnabled(true);
  assert.equal(follow.isPausedNow, false, 'the spider being hidden pausing is the step gate, not the pause gate');
  assert.equal(follow.step(1), false);
  assert.equal(camera.views.length, 0);
});

test('a flight that owns the camera stops the drift', () => {
  const camera = cameraDouble({ lat: 10, lon: 0, moving: true });
  const follow = createSpiderCameraFollow({
    camera,
    state: { latDeg: 30, lonDeg: 30, visible: true },
    cesium: CESIUM,
  });
  follow.setEnabled(true);
  assert.equal(follow.step(1), false);
  assert.equal(camera.views.length, 0);
});

test('a tool holding the pointer stops the drift', () => {
  const camera = cameraDouble({ lat: 10, lon: 0 });
  const follow = createSpiderCameraFollow({
    camera,
    state: { latDeg: 30, lonDeg: 30, visible: true },
    cesium: CESIUM,
  });
  follow.setEnabled(true);
  const lease = claimPointer('draw');
  assert.equal(follow.step(1), false);
  assert.equal(camera.views.length, 0);
  releasePointer(lease);
  assert.equal(follow.step(1), true, 'releasing the pointer resumes the drift');
  assert.equal(camera.views.length, 1);
  resetPointerOwnership();
});

test('a pointer gesture pauses the drift and ends after a cooldown', () => {
  const clock = moduloNow();
  const canvas = canvasDouble();
  const camera = cameraDouble({ lat: 10, lon: 0 });
  const follow = createSpiderCameraFollow({
    camera,
    canvas,
    state: { latDeg: 30, lonDeg: 30, visible: true },
    now: clock.now,
    cesium: CESIUM,
  });
  follow.setEnabled(true);
  assert.equal(follow.step(1), true);
  assert.equal(camera.views.length, 1);

  canvas.fire('pointerdown');
  assert.equal(follow.isPausedNow, true);
  assert.equal(follow.step(1), false, 'no drift while the drag lives');
  canvas.fire('pointerup');
  assert.equal(
    follow.step(1),
    false,
    'Cesium inertia trails the lift: the cooldown holds',
  );
  clock.advance(FOLLOW_RELEASE_COOLDOWN_MS - 1);
  assert.equal(follow.step(1), false, 'one ms short is still cooling');
  clock.advance(1);
  assert.equal(follow.step(1), true, 'the cooldown ends, the drift resumes');
  assert.equal(camera.views.length, 2);
});

test('a touch or mouse gesture behaves like a pointer gesture', () => {
  const clock = moduloNow();
  const canvas = canvasDouble();
  const camera = cameraDouble({ lat: 10, lon: 0 });
  const follow = createSpiderCameraFollow({
    camera,
    canvas,
    state: { latDeg: 30, lonDeg: 30, visible: true },
    now: clock.now,
    cesium: CESIUM,
  });
  follow.setEnabled(true);
  assert.equal(follow.step(0.5), true);
  for (const [down, up] of [
    ['touchstart', 'touchend'],
    ['mousedown', 'mouseup'],
    ['touchstart', 'touchcancel'],
    ['pointerdown', 'pointercancel'],
  ]) {
    canvas.fire(down);
    assert.equal(follow.step(0.5), false, `${down} pauses`);
    canvas.fire(up);
    assert.equal(follow.step(0.5), false, 'the cooldown follows any end event');
    clock.advance(FOLLOW_RELEASE_COOLDOWN_MS);
    assert.equal(follow.step(0.5), true);
  }
});

test('a wheel burst pauses the drift for a shorter cooldown', () => {
  const clock = moduloNow();
  const canvas = canvasDouble();
  const camera = cameraDouble({ lat: 10, lon: 0 });
  const follow = createSpiderCameraFollow({
    camera,
    canvas,
    state: { latDeg: 30, lonDeg: 30, visible: true },
    now: clock.now,
    cesium: CESIUM,
  });
  follow.setEnabled(true);
  assert.equal(follow.step(1), true);
  canvas.fire('wheel');
  assert.equal(follow.step(1), false);
  clock.advance(FOLLOW_WHEEL_COOLDOWN_MS - 1);
  assert.equal(follow.step(1), false);
  clock.advance(1);
  assert.equal(follow.step(1), true);
  // Each wheel step of a burst re-arms the same short cooldown.
  canvas.fire('wheel');
  canvas.fire('wheel');
  assert.equal(follow.step(1), false);
  clock.advance(FOLLOW_WHEEL_COOLDOWN_MS);
  assert.equal(follow.step(1), true);
});

test('resuming after a long pause drifts from where the camera is now', () => {
  const clock = moduloNow();
  const canvas = canvasDouble();
  // The camera ended a manipulation far from the spider (the operator dragged
  // away), and the spider meanwhile kept walking; the resume must step from
  // the camera's CURRENT position at a share of the remaining distance, never
  // snap to the spider.
  const camera = cameraDouble({ lat: 5, lon: 0 });
  const follow = createSpiderCameraFollow({
    camera,
    canvas,
    state: { latDeg: 40, lonDeg: 0, visible: true },
    now: clock.now,
    cesium: CESIUM,
  });
  follow.setEnabled(true);
  canvas.fire('pointerdown');
  canvas.fire('pointerup');
  clock.advance(FOLLOW_RELEASE_COOLDOWN_MS);
  const moved = follow.step(1);
  assert.equal(moved, true);
  const step = camera.views[0].destination.lat - 5;
  const expected = (40 - 5) * (1 - Math.exp(-FOLLOW_RATE_PER_S));
  assert.ok(
    Math.abs(step - expected) < 1e-9,
    'the resume step is the proportional share of the current distance',
  );
  assert.ok(step < 35, 'the camera never teleports to the spider');
});

test('destroy removes the gesture listeners', () => {
  const clock = moduloNow();
  const canvas = canvasDouble();
  const camera = cameraDouble({ lat: 10, lon: 0 });
  const follow = createSpiderCameraFollow({
    camera,
    canvas,
    state: { latDeg: 30, lonDeg: 30, visible: true },
    now: clock.now,
    cesium: CESIUM,
  });
  follow.setEnabled(true);
  const boundBefore = [...canvas.bound.entries()].reduce(
    (total, [, list]) => total + list.length,
    0,
  );
  assert.ok(boundBefore > 0, 'the follow did bind its listeners');
  follow.destroy();
  const boundAfter = [...canvas.bound.entries()].reduce(
    (total, [, list]) => total + list.length,
    0,
  );
  assert.equal(boundAfter, 0, 'every listener came back off the canvas');
  assert.equal(follow.step(1), false);
  assert.equal(follow.isEnabled, false);

  // One more gesture after destroy can never pause a dead follow, and there is
  // no listener left to receive it anyway.
  canvas.fire('pointerdown');
  assert.equal(follow.step(1), false);
});

test('a follow without a camera or a canvas is inert, not fatal', () => {
  const follow = createSpiderCameraFollow({
    state: { latDeg: 30, lonDeg: 30, visible: true },
    cesium: CESIUM,
  });
  follow.setEnabled(true);
  assert.equal(follow.step(1), false);
  follow.destroy();
  const follow2 = createSpiderCameraFollow({
    camera: cameraDouble({ lat: 10, lon: 0 }),
    state: { latDeg: 40, lonDeg: 40, visible: true },
    cesium: {},
  });
  follow2.setEnabled(true);
  assert.equal(follow2.step(1), false, 'a Cesium stub without Math, no drift');
  follow2.destroy();
});

test('a camera that refuses the pose does not throw out of the tick', () => {
  const camera = cameraDouble({ lat: 10, lon: 0 });
  camera.setView = () => {
    throw new Error('refused');
  };
  const follow = createSpiderCameraFollow({
    camera,
    state: { latDeg: 30, lonDeg: 30, visible: true },
    cesium: CESIUM,
  });
  follow.setEnabled(true);
  assert.equal(follow.step(1), false, 'the refusal is swallowed');
});
