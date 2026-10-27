import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_POINTS,
  boundsQuery,
  clampViewport,
  normalisePoint,
  normalisePoints,
  normaliseBounds,
  pointsSignature,
} from './records.js';

test('a malformed or inverted view is not a query', () => {
  assert.equal(normaliseBounds(null), null);
  assert.equal(
    normaliseBounds({ west: 0, south: 10, east: 0, north: 5 }),
    null,
  );
  assert.equal(
    normaliseBounds({ west: 0, south: 0, east: 'east', north: 1 }),
    null,
  );
  assert.deepEqual(
    normaliseBounds({ west: -1, south: -2, east: 3, north: 4 }),
    {
      west: -1,
      south: -2,
      east: 3,
      north: 4,
    },
  );
});

test('a continental or world view is shrunk to one request around its centre', () => {
  const world = clampViewport({ west: -180, south: -85, east: 180, north: 85 });
  assert.equal(world.clamped, true);
  assert.ok(Math.abs((world.bounds.west + world.bounds.east) / 2) < 1e-9);
  assert.equal(
    Math.round((world.bounds.east - world.bounds.west) * 1000) / 1000,
    6,
  );

  const city = { west: 2.2, south: 48.8, east: 2.5, north: 48.9 };
  const kept = clampViewport(city);
  assert.equal(kept.clamped, false);
  assert.deepEqual(kept.bounds, city);

  // The camera can report a view wider in latitude than longitude.
  const tall = clampViewport({ west: 2, south: -60, east: 3, north: 70 });
  assert.equal(tall.clamped, true);
  assert.equal(Math.round(tall.bounds.north - tall.bounds.south), 6);
});

test('the query string carries four decimals and never an empty option', () => {
  const query = boundsQuery(
    { west: 2.123456, south: 48.1, east: 2.5, north: 48.9 },
    { source: 'ttn', extra: '' },
  );
  const params = new URLSearchParams(query);
  assert.equal(params.get('west'), '2.1235');
  assert.equal(params.get('source'), 'ttn');
  assert.equal(params.has('extra'), false);
  assert.equal(boundsQuery(null), '');
});

test('coordinates out of range are dropped rather than drawn at the equator', () => {
  assert.equal(normalisePoint({ id: 'a', lat: 200, lon: 0 }), null);
  assert.equal(normalisePoint({ id: 'a', lat: 'x', lon: 0 }), null);
  assert.equal(normalisePoint({ id: 'a', lat: 0, lon: 'x' }), null, 'NaN lon');
  assert.deepEqual(normalisePoint({ id: 'a', lat: 48, lon: 2 }), {
    id: 'a',
    lat: 48,
    lon: 2,
    label: 'a',
    meta: {},
  });
  assert.equal(
    normalisePoint({ _id: 'mongo', currentLocation: {} }),
    null,
    'a provider row without coordinates is not a point',
  );
  assert.equal(normalisePoint({ lat: 1, lon: 2 }), null, 'no identity');
});

test('duplicate ids collapse and the cap holds', () => {
  const rows = [
    { id: 'a', lat: 1, lon: 1 },
    { id: 'a', lat: 9, lon: 9 },
    { id: 'b', lat: 2, lon: 2 },
    { id: 'c', lat: 3, lon: 3 },
  ];
  const points = normalisePoints(rows, 2);
  assert.deepEqual(
    points.map((point) => point.id),
    ['a', 'b'],
  );
  assert.equal(points[0].lat, 1);
  assert.equal(normalisePoints(rows).length, 3);
  assert.equal(normalisePoints(null).length, 0);
  assert.ok(MAX_POINTS >= 500);
});

test('the drawn signature ignores fields the primitives do not show', () => {
  const base = [{ id: 'a', lat: 1.23456, lon: 2.34567, label: 'x', meta: {} }];
  assert.equal(
    pointsSignature(base),
    pointsSignature([{ ...base[0], label: 'other', meta: { k: 1 } }]),
  );
  assert.notEqual(
    pointsSignature(base),
    pointsSignature([{ ...base[0], lon: 2.4 }]),
  );
});
