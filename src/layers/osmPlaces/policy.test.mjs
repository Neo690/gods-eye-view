import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CATEGORY_COLOURS,
  MAX_VIEWPORT_DEGREES,
  QUERY_LIMIT,
  categoryFor,
  kindFor,
  osmPlacesQuery,
  overpassBbox,
  overpassTurboQuery,
  overpassTurboUrl,
  turboZoomForSpan,
} from './policy.js';

const PARIS = { south: 48.8, west: 2.2, north: 48.9, east: 2.5 };

test('the bounded query asks every place family inside the view', () => {
  const query = osmPlacesQuery(PARIS);
  assert.match(query, /^\[out:json\]\[timeout:25\];/);
  for (const key of [
    'amenity',
    'shop',
    'tourism',
    'historic',
    'leisure',
    'office',
    'craft',
  ]) {
    assert.match(
      query,
      new RegExp(`nwr\\["name"\\]\\["${key}"\\]\\(48\\.80000,2\\.20000,48\\.90000,2\\.50000\\);`),
    );
  }
  assert.match(query, new RegExp(`out center ${QUERY_LIMIT};$`));
});

test('a missing or inverted view is refused, never sent as a world query', () => {
  assert.throws(() => overpassBbox(null), TypeError);
  assert.throws(
    () => overpassBbox({ south: 10, west: 0, north: 5, east: 1 }),
    TypeError,
  );
  assert.throws(
    () => overpassBbox({ south: 0, west: 5, north: 1, east: 1 }),
    TypeError,
  );
});

test('the Turbo query leaves the bbox to the editor', () => {
  const query = overpassTurboQuery();
  assert.match(query, /\{\{bbox\}\}/);
  assert.doesNotMatch(query, /48\.80000/);
  assert.match(query, new RegExp(`out center ${QUERY_LIMIT};$`));
});

test('the Turbo permalink carries the centre, a matching zoom, and runs', () => {
  const url = new URL(overpassTurboUrl(PARIS));
  assert.equal(url.origin + url.pathname, 'https://overpass-turbo.eu/');
  assert.equal(url.searchParams.get('C'), '48.85000;2.35000;12');
  assert.equal(url.searchParams.has('R'), true);
  assert.match(url.searchParams.get('Q'), /\{\{bbox\}\}/);
  assert.equal(overpassTurboUrl(null), null);
  assert.equal(
    overpassTurboUrl({ south: 10, west: 0, north: 5, east: 1 }),
    null,
  );
});

test('zoom follows the span without leaving the editor range', () => {
  assert.equal(turboZoomForSpan(0.1), 14);
  assert.equal(turboZoomForSpan(0), 15);
  assert.equal(turboZoomForSpan(Number.NaN), 15);
  assert.equal(turboZoomForSpan(360), 2);
  assert.equal(turboZoomForSpan(0.0000001), 17);
  assert.ok(MAX_VIEWPORT_DEGREES >= 1);
});

test('a place family is decided by the strongest tag it carries', () => {
  assert.equal(categoryFor({ amenity: 'restaurant' }), 'food');
  assert.equal(categoryFor({ amenity: 'fast_food', shop: 'bakery' }), 'food');
  assert.equal(categoryFor({ amenity: 'pharmacy' }), 'services');
  assert.equal(categoryFor({ shop: 'supermarket' }), 'shop');
  assert.equal(categoryFor({ tourism: 'museum' }), 'culture');
  assert.equal(categoryFor({ historic: 'monument' }), 'culture');
  assert.equal(categoryFor({ leisure: 'park' }), 'culture');
  assert.equal(categoryFor({ office: 'company' }), 'other');
  assert.equal(categoryFor({ craft: 'carpenter' }), 'other');
  assert.equal(categoryFor(null), 'other');
  for (const category of ['food', 'shop', 'culture', 'services', 'other']) {
    assert.ok(CATEGORY_COLOURS[category], `missing colour for ${category}`);
  }
});

test('the kind is the OSM value, not the display category', () => {
  assert.equal(kindFor({ amenity: 'cafe' }), 'cafe');
  assert.equal(kindFor({ shop: 'bakery' }), 'bakery');
  assert.equal(kindFor({ tourism: 'hotel' }), 'hotel');
  assert.equal(kindFor({ historic: 'castle' }), 'castle');
  assert.equal(kindFor({ leisure: 'park' }), 'park');
  assert.equal(kindFor({ office: 'it' }), 'it');
  assert.equal(kindFor({ craft: 'plumber' }), 'plumber');
  assert.equal(kindFor(null), 'place');
});
