import assert from 'node:assert/strict';
import test from 'node:test';

import {
  greenwichSiderealDegrees,
  subsolarPoint,
} from './sun.js';

const longitudeDistance = (a, b) => {
  const diff = Math.abs(((a - b) % 360) + 360) % 360;
  return Math.min(diff, 360 - diff);
};

test('the subsolar point sits on the tropics at the solstices', () => {
  const june = subsolarPoint(Date.UTC(2026, 5, 21, 12, 0, 0));
  assert.ok(Math.abs(june.lat - 23.44) < 0.4, `june lat ${june.lat}`);
  assert.ok(longitudeDistance(june.lon, 0) < 5, `june lon ${june.lon}`);

  const december = subsolarPoint(Date.UTC(2026, 11, 21, 12, 0, 0));
  assert.ok(Math.abs(december.lat + 23.44) < 0.4, `december lat ${december.lat}`);
});

test('it crosses the equator at the equinox', () => {
  const march = subsolarPoint(Date.UTC(2026, 2, 20, 14, 46, 0));
  assert.ok(Math.abs(march.lat) < 0.5, `equinox lat ${march.lat}`);
});

test('it walks a quarter of the globe every six hours', () => {
  const noon = subsolarPoint(Date.UTC(2026, 0, 15, 12, 0, 0));
  const six = subsolarPoint(Date.UTC(2026, 0, 15, 18, 0, 0));
  assert.ok(longitudeDistance(noon.lon, 0) < 5, `noon lon ${noon.lon}`);
  // At 18:00 UTC the Sun stands near 90°W (equation of time included).
  assert.ok(longitudeDistance(six.lon, -90) < 5, `18h lon ${six.lon}`);
});

test('sidereal time stays in one turn', () => {
  for (const ms of [0, Date.UTC(2026, 9, 30), Date.UTC(1999, 0, 1, 5)]) {
    const degrees = greenwichSiderealDegrees(ms);
    assert.ok(degrees >= 0 && degrees < 360, `${degrees} out of range`);
  }
});
