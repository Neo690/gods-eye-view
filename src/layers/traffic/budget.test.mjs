import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DOTS,
  PHONE_MAX_DOTS,
  PHONE_SURFACE_STATION_BUDGET,
  SURFACE_STATION_BUDGET,
  roadDotBudget,
  trafficWorkBudget,
} from './policy.js';

const view = (phone) => ({
  matchMedia: (query) => ({ matches: phone && query.includes('720px') }),
});

test('a phone layout gets a smaller street fleet and fewer surface samples', () => {
  assert.deepEqual(trafficWorkBudget(view(true)), {
    maxDots: PHONE_MAX_DOTS,
    surfaceStations: PHONE_SURFACE_STATION_BUDGET,
  });
  assert.deepEqual(trafficWorkBudget(view(false)), {
    maxDots: MAX_DOTS,
    surfaceStations: SURFACE_STATION_BUDGET,
  });
  assert.deepEqual(
    trafficWorkBudget(globalThis),
    { maxDots: MAX_DOTS, surfaceStations: SURFACE_STATION_BUDGET },
    'a runtime without matchMedia keeps the desktop budget',
  );
});

test('the road dot budget never exceeds the ceiling it is handed', () => {
  assert.equal(roadDotBudget(600, PHONE_MAX_DOTS), PHONE_MAX_DOTS);
  assert.equal(roadDotBudget(600, MAX_DOTS), MAX_DOTS);
  assert.ok(
    roadDotBudget(600, PHONE_MAX_DOTS) < roadDotBudget(600, MAX_DOTS),
    'the phone ceiling really is the smaller one',
  );
  assert.equal(
    roadDotBudget(20_000, PHONE_MAX_DOTS),
    400,
    'the floor still guarantees a visible fleet when zoomed out',
  );
});
