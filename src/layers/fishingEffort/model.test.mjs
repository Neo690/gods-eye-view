import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DRAWN_CELLS,
  boundsFromRadians,
  effortSummary,
  hoursCeiling,
  intensity,
  normalizeEffort,
  viewportAllowed,
} from './model.js';

test('an answer is clipped to real coordinates and sorted by effort', () => {
  const answer = normalizeEffort({
    cells: [
      { lat: 10, lon: 20, hours: 1 },
      { lat: 11, lon: 21, hours: 9 },
      { lat: 'x', lon: 22, hours: 5 },
      { lat: 12, lon: 23, hours: -3 },
      { lat: 95, lon: 24, hours: 2 },
    ],
    totalHours: 12,
    cellCount: 3,
  });
  assert.deepEqual(
    answer.cells.map((cell) => cell.hours),
    [9, 1],
  );
  assert.equal(answer.totalHours, 12);
  assert.equal(answer.cellCount, 3);
});

test('a payload without counts still adds up what it kept', () => {
  const answer = normalizeEffort({
    cells: [
      { lat: 1, lon: 2, hours: 2.5 },
      { lat: 3, lon: 4, hours: 1.5 },
    ],
  });
  assert.equal(answer.totalHours, 4);
  assert.equal(answer.cellCount, 2);
  assert.equal(answer.truncated, false);
  assert.equal(normalizeEffort(null).cells.length, 0);
});

test('the cap is respected and reported', () => {
  const cells = Array.from({ length: 5 }, (_, index) => ({
    lat: index,
    lon: index,
    hours: 10 - index,
  }));
  const answer = normalizeEffort({ cells }, { limit: 3 });
  assert.equal(answer.cells.length, 3);
  assert.equal(answer.truncated, true);
  assert.equal(MAX_DRAWN_CELLS, 800);
});

test('the scale is square-rooted against the 95th percentile, not the maximum', () => {
  const cells = [
    { hours: 1 },
    { hours: 2 },
    { hours: 3 },
    { hours: 100 },
  ];
  const ceiling = hoursCeiling(cells);
  assert.equal(ceiling, 100);
  assert.equal(intensity(100, ceiling), 1);
  assert.ok(intensity(25, ceiling) > 0.4 && intensity(25, ceiling) < 0.6);
  assert.equal(intensity(0, ceiling), 0);
  assert.equal(intensity('x', ceiling), 0);
  assert.equal(hoursCeiling([]), 0);
  const many = Array.from({ length: 100 }, (_, index) => ({ hours: index + 1 }));
  assert.ok(hoursCeiling(many) < 100);
});

test('the summary names hours, cells and the window', () => {
  assert.equal(
    effortSummary({ totalHours: 1234, cellCount: 210, days: 7 }),
    '1234 h · 210 cells · 7d',
  );
  assert.equal(
    effortSummary({ totalHours: 3.14, cellCount: 2, days: 7 }),
    '3.1 h · 2 cells · 7d',
  );
  assert.equal(effortSummary({ totalHours: 0, cellCount: 0 }), null);
});

test('a viewport is bounded, and radians convert to the degrees the route wants', () => {
  assert.equal(
    viewportAllowed({ west: -20, east: 20, south: -10, north: 10 }),
    true,
  );
  assert.equal(
    viewportAllowed({ west: -80, east: 40, south: -10, north: 10 }),
    false,
  );
  assert.equal(viewportAllowed({ west: 'x', east: 1, south: 0, north: 1 }), false);
  const bounds = boundsFromRadians({
    west: -Math.PI / 2,
    east: Math.PI / 4,
    south: -Math.PI / 6,
    north: Math.PI / 3,
  });
  assert.ok(Math.abs(bounds.west + 90) < 1e-9);
  assert.ok(Math.abs(bounds.east - 45) < 1e-9);
  assert.ok(Math.abs(bounds.south + 30) < 1e-9);
  assert.ok(Math.abs(bounds.north - 60) < 1e-9);
});
