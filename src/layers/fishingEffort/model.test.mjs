import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CELL_DEGREES,
  MAX_DRAWN_CELLS,
  ZONE_MIN_INTENSITY,
  activityZones,
  boundsFromRadians,
  effortSummary,
  hoursCeiling,
  intensity,
  normalizeEffort,
  viewportAllowed,
} from './model.js';

/** A cell centred on the lattice point (i, j). */
const at = (i, j, hours = 10) => ({
  lat: j * CELL_DEGREES,
  lon: i * CELL_DEGREES,
  hours,
});

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
  const cells = [{ hours: 1 }, { hours: 2 }, { hours: 3 }, { hours: 100 }];
  const ceiling = hoursCeiling(cells);
  assert.equal(ceiling, 100);
  assert.equal(intensity(100, ceiling), 1);
  assert.ok(intensity(25, ceiling) > 0.4 && intensity(25, ceiling) < 0.6);
  assert.equal(intensity(0, ceiling), 0);
  assert.equal(intensity('x', ceiling), 0);
  assert.equal(hoursCeiling([]), 0);
  const many = Array.from({ length: 100 }, (_, index) => ({
    hours: index + 1,
  }));
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
  assert.equal(
    viewportAllowed({ west: 'x', east: 1, south: 0, north: 1 }),
    false,
  );
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

test('a block of dense cells becomes one zone with a rectangular outline', () => {
  const zones = activityZones([at(0, 0), at(1, 0), at(0, 1), at(1, 1)]);
  assert.equal(zones.length, 1);
  const [zone] = zones;
  assert.equal(zone.cellCount, 4);
  assert.equal(zone.totalHours, 40);
  assert.equal(zone.intensity, 1);
  assert.equal(zone.outlines.length, 1, 'a solid block is one outline');
  assert.equal(zone.outlines[0].rings.length, 1, 'with one ring');
  assert.equal(
    zone.outlines[0].rings[0].positions.length,
    4,
    'and four corners',
  );
  // The outline is the union of the squares, not the points: half a cell on
  // every side.
  assert.equal(zone.bounds.west, -CELL_DEGREES / 2);
  assert.equal(zone.bounds.east, 1.5 * CELL_DEGREES);
  assert.equal(zone.bounds.south, -CELL_DEGREES / 2);
  assert.equal(zone.bounds.north, 1.5 * CELL_DEGREES);
  assert.equal(zone.centroid.lat, 0.05);
  assert.equal(zone.centroid.lon, 0.05);
});

test('a diagonal chain is one zone, drawn as the squares it really holds', () => {
  const zones = activityZones([at(0, 0), at(1, 1), at(2, 2), at(3, 3)]);
  assert.equal(
    zones.length,
    1,
    'a band is one zone even when it runs diagonally',
  );
  assert.equal(zones[0].cellCount, 4);
  // Corner contact encloses no area: the outline is one square per cell, not
  // the rectangle around the staircase, which would paint empty water.
  assert.equal(zones[0].outlines.length, 4);
  for (const outline of zones[0].outlines) {
    assert.equal(outline.rings.length, 1);
    assert.equal(outline.rings[0].positions.length, 4);
    assert.equal(
      outline.rings[0].area.toFixed(4),
      (CELL_DEGREES ** 2).toFixed(4),
    );
  }
  assert.equal(zones[0].ringCount, 4);
});

test('background effort is left out and a small group is not a zone', () => {
  // One intense square and three faint ones far away: the faint cells are
  // below the share of the ceiling, so nothing reaches the minimum size.
  const sparse = activityZones([
    at(0, 0, 100),
    at(40, 0, 1),
    at(41, 0, 1),
    at(40, 1, 1),
  ]);
  assert.deepEqual(sparse, []);
  // With the floor dropped, the same cells do group.
  const grouped = activityZones(
    [at(40, 0, 1), at(41, 0, 1), at(40, 1, 1), at(41, 1, 1)],
    { minIntensity: 0 },
  );
  assert.equal(grouped.length, 1);
  assert.equal(
    activityZones([at(0, 0), at(1, 0)], { minIntensity: 0 }).length,
    0,
  );
  assert.ok(ZONE_MIN_INTENSITY > 0);
});

test('a zone with a hole keeps the hole as a second ring', () => {
  const cells = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (i === 1 && j === 1) continue;
      cells.push(at(i, j));
    }
  }
  const [zone] = activityZones(cells);
  assert.equal(zone.cellCount, 8);
  assert.equal(zone.outlines.length, 1);
  const rings = zone.outlines[0].rings;
  assert.equal(rings.length, 2);
  // The outer ring is first and is the larger of the two.
  assert.ok(rings[0].area > rings[1].area);
  assert.equal(rings[1].positions.length, 4);
  assert.equal(rings[1].area.toFixed(4), (CELL_DEGREES ** 2).toFixed(4));
});

test('zones are ranked by effort, capped, and scaled to the strongest', () => {
  const strong = [at(0, 0, 30), at(1, 0, 30), at(0, 1, 30), at(1, 1, 30)];
  const weak = [at(20, 0, 10), at(21, 0, 10), at(20, 1, 10), at(21, 1, 10)];
  const capped = activityZones([...strong, ...weak], { ceiling: 30, limit: 1 });
  assert.equal(capped.length, 1);
  assert.equal(capped[0].totalHours, 120);
  assert.equal(capped[0].intensity, 1);

  const both = activityZones([...strong, ...weak], { ceiling: 30 });
  assert.equal(both.length, 2);
  assert.ok(both[0].totalHours > both[1].totalHours);
  assert.equal(both[0].intensity, 1);
  assert.ok(both[1].intensity < 1 && both[1].intensity > 0);
});
