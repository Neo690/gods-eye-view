import assert from 'node:assert/strict';
import test from 'node:test';

import { QUERY_LIMIT } from './policy.js';
import {
  elementPosition,
  normalizePlaceElement,
  normalizePlaces,
} from './records.js';

test('a node, a way centre and a relation centre all become one row shape', () => {
  const rows = normalizePlaces([
    {
      type: 'node',
      id: 1,
      lat: 48.85,
      lon: 2.35,
      tags: { name: 'Café de Flore', amenity: 'cafe' },
    },
    {
      type: 'way',
      id: 2,
      center: { lat: 48.86, lon: 2.36 },
      tags: { name: 'Marché', shop: 'supermarket' },
    },
    {
      type: 'relation',
      id: 3,
      center: { lat: 48.87, lon: 2.37 },
      tags: { name: 'Musée', tourism: 'museum' },
    },
  ]);
  assert.deepEqual(rows.rows, [
    {
      id: 'node/1',
      lat: 48.85,
      lon: 2.35,
      label: 'Café de Flore',
      meta: { category: 'food', kind: 'cafe' },
    },
    {
      id: 'way/2',
      lat: 48.86,
      lon: 2.36,
      label: 'Marché',
      meta: { category: 'shop', kind: 'supermarket' },
    },
    {
      id: 'relation/3',
      lat: 48.87,
      lon: 2.37,
      label: 'Musée',
      meta: { category: 'culture', kind: 'museum' },
    },
  ]);
  assert.equal(rows.saturated, false);
});

test('unnamed, unpositioned, null-island and duplicate elements are dropped', () => {
  const rows = normalizePlaces([
    { type: 'node', id: 1, lat: 48.85, lon: 2.35, tags: { amenity: 'bench' } },
    {
      type: 'node',
      id: 2,
      lat: 48.85,
      lon: 2.35,
      tags: { name: '   ', amenity: 'bench' },
    },
    { type: 'way', id: 3, tags: { name: 'Nowhere', shop: 'kiosk' } },
    {
      type: 'node',
      id: 4,
      lat: 0,
      lon: 0,
      tags: { name: 'Null Island', tourism: 'attraction' },
    },
    {
      type: 'node',
      id: 5,
      lat: 200,
      lon: 2,
      tags: { name: 'Out of range', tourism: 'attraction' },
    },
    {
      type: 'node',
      id: 6,
      lat: 48.9,
      lon: 2.4,
      tags: { name: 'Bakery', shop: 'bakery' },
    },
    {
      type: 'node',
      id: 6,
      lat: 48.9,
      lon: 2.4,
      tags: { name: 'Bakery again', shop: 'bakery' },
    },
  ]);
  assert.deepEqual(
    rows.rows.map((row) => row.label),
    ['Bakery'],
  );
});

test('two same-named places at the same corner are both real', () => {
  const rows = normalizePlaces([
    {
      type: 'node',
      id: 1,
      lat: 48.85,
      lon: 2.35,
      tags: { name: 'Pharmacie', amenity: 'pharmacy' },
    },
    {
      type: 'node',
      id: 2,
      lat: 48.85001,
      lon: 2.35001,
      tags: { name: 'Pharmacie', amenity: 'pharmacy' },
    },
  ]);
  assert.equal(rows.rows.length, 2);
});

test('the result cap reports saturation without inventing rows', () => {
  const elements = Array.from({ length: QUERY_LIMIT }, (_, index) => ({
    type: 'node',
    id: index + 1,
    lat: 48.8,
    lon: 2.3,
    tags: { name: `Place ${index}`, amenity: 'bench' },
  }));
  const rows = normalizePlaces(elements);
  assert.equal(rows.saturated, true);
  assert.equal(rows.rows.length, QUERY_LIMIT);
  assert.equal(normalizePlaces(null).rows.length, 0);
});

test('element position prefers a real coordinate over a missing one', () => {
  assert.deepEqual(elementPosition({ lat: 1, lon: 2 }), { lat: 1, lon: 2 });
  assert.deepEqual(elementPosition({ center: { lat: 3, lon: 4 } }), {
    lat: 3,
    lon: 4,
  });
  assert.equal(elementPosition({ lat: 1 }), null);
  assert.equal(elementPosition({ lat: 0, lon: 0 }), null);
  assert.equal(normalizePlaceElement(null), null);
});
