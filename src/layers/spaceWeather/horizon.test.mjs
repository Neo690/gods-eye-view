import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import { createHorizonCuller } from './horizon.js';

const ALTITUDE_M = 12_000_000;

/** Visibility of one point as the camera walks a longitude path, in steps. */
function walk(culler, point, longitudes, startShown = false) {
  const states = [];
  // Cells start hidden; the first frame is what the layer would paint first.
  let shown = startShown;
  for (const lon of longitudes) {
    culler.setCamera(Cesium.Cartesian3.fromDegrees(lon, 35, ALTITUDE_M));
    shown = culler.isVisible(point, shown);
    states.push(shown);
  }
  return states;
}

function transitions(states) {
  let count = 0;
  for (let i = 1; i < states.length; i++) if (states[i] !== states[i - 1]) count++;
  return count;
}

test('a steady orbit shows a limb cell once and hides it once', () => {
  const culler = createHorizonCuller();
  const point = Cesium.Cartesian3.fromDegrees(0, 68);
  const longitudes = Array.from({ length: 3600 }, (_, i) => -180 + i * 0.1);
  const states = walk(culler, point, longitudes);
  assert.equal(transitions(states), 2);
  // Hidden on the far side, shown as the camera sweeps past it, hidden again.
  assert.equal(states[0], false);
  assert.equal(states.at(-1), false);
  assert.equal(states.filter(Boolean).length > 0, true);
});

test('a hand jittering on the horizon no longer blinks the cell', () => {
  const culler = createHorizonCuller();
  const point = Cesium.Cartesian3.fromDegrees(0, 68);
  // The heading where this cell sits on the limb for the camera above.
  const center = (() => {
    const probe = createHorizonCuller({ hysteresis: 0 });
    for (let lon = -180; lon <= 180; lon += 0.01) {
      probe.setCamera(Cesium.Cartesian3.fromDegrees(lon, 35, ALTITUDE_M));
      if (probe.isVisible(point, false)) return lon;
    }
    throw new Error('The cell never entered the visible cap');
  })();
  const jitter = Array.from({ length: 240 }, (_, i) =>
    center + Math.sin((i / 240) * Math.PI * 8) * 0.02,
  );
  // Start from the state a viewer would already see at that heading: the cell
  // is drawn, and the jitter must not take it away.
  const states = walk(culler, point, jitter, true);
  assert.equal(states[0], true);
  assert.equal(transitions(states), 0);
});

test('the far side never shows', () => {
  const culler = createHorizonCuller();
  culler.setCamera(Cesium.Cartesian3.fromDegrees(0, 0, ALTITUDE_M));
  for (const lon of [80, 90, 120, 180]) {
    const point = Cesium.Cartesian3.fromDegrees(lon, 0);
    assert.equal(culler.isVisible(point, false), false, `${lon}° should hide`);
  }
  // A hidden far-side cell never re-appears just because it is currently shown.
  for (const lon of [100, 120, 180]) {
    const point = Cesium.Cartesian3.fromDegrees(lon, 0);
    assert.equal(culler.isVisible(point, true), false, `${lon}° should hide`);
  }
});
