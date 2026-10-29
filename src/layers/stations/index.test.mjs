import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LABEL_COHORT_LIMIT,
  MAX_VIEWPORT_DEGREES,
  QUERY_LIMIT,
  STATION_SELECTED_COLOR,
  buildStationSelectionCopy,
  clampViewport,
  createStationOverlayEntry,
  createStationSelectedOverlayEntry,
  selectStationCohort,
  shouldRefetch,
  stationIdFromPick,
  stationPriority,
  stationsQuery,
  viewportDelta,
} from './policy.js';
import {
  approxMeters,
  normalizeStationElement,
  normalizeStations,
} from './records.js';

const PARIS = { south: 48.8, west: 2.25, north: 48.9, east: 2.4 };

test('the station query is bounded, keyless, and capped', () => {
  const query = stationsQuery(PARIS);
  assert.match(query, /\[out:json\]/);
  assert.match(query, /\[timeout:25\]/);
  // Both geometries are asked for, inside ONE union block: two bare statements
  // chain in Overpass QL (the second filters the first) and return nothing.
  assert.match(query, /\(node\["railway"="station"\]\(48\.80000,/);
  assert.match(
    query,
    /node\["railway"="station"\]\(48\.80000,2\.25000,48\.90000,2\.40000\)/,
  );
  assert.match(
    query,
    /way\["railway"="station"\]\(48\.80000,2\.25000,48\.90000,2\.40000\);\);/,
  );
  assert.match(query, new RegExp(`out center ${QUERY_LIMIT};$`));
  assert.equal(/key=|token=/i.test(query), false, 'no key in the query');
});

test('a view wider than the layer asks for is clamped, not dropped', () => {
  const wide = { south: 35, west: -8, north: 55, east: 12 };
  const clamped = clampViewport(wide);
  assert.equal(clamped.north - clamped.south, MAX_VIEWPORT_DEGREES);
  assert.equal(clamped.east - clamped.west, MAX_VIEWPORT_DEGREES);
  // The middle of the view is what stays readable.
  assert.ok(Math.abs((clamped.south + clamped.north) / 2 - 45) < 1e-9);
  assert.ok(Math.abs((clamped.west + clamped.east) / 2 - 2) < 1e-9);
  // A view already inside the limit is untouched.
  assert.deepEqual(clampViewport(PARIS), PARIS);
  // Nothing usable comes back as nothing, never as a world-sized box.
  assert.equal(clampViewport(null), null);
  assert.equal(clampViewport({ south: 10, west: 1, north: 5, east: 2 }), null);
  assert.equal(clampViewport({ south: NaN, west: 1, north: 5, east: 2 }), null);
});

test('a parked camera does not re-poll the mirror', () => {
  assert.equal(viewportDelta(null, PARIS), Infinity);
  assert.equal(viewportDelta(PARIS, PARIS), 0);
  // First load always runs, even for an unchanged box.
  assert.equal(shouldRefetch(null, PARIS, false), true);
  assert.equal(shouldRefetch(PARIS, { ...PARIS }, true), false);
  // A small nudge is still the same answer.
  assert.equal(
    shouldRefetch(PARIS, { ...PARIS, north: PARIS.north + 0.005 }, true),
    false,
  );
  // Moving a tenth of a degree is worth a new query; an unknown view is not.
  assert.equal(
    shouldRefetch(PARIS, { ...PARIS, north: PARIS.north + 0.1 }, true),
    true,
  );
  assert.equal(shouldRefetch(PARIS, null, true), false);
});

test('only named, positioned stations become records', () => {
  const node = {
    type: 'node',
    id: 271234,
    lat: 48.8443,
    lon: 2.3744,
    tags: {
      railway: 'station',
      name: 'Paris Gare de Lyon',
      operator: 'SNCF',
      network: 'TER',
      usage: 'main',
      platforms: '26',
    },
  };
  assert.deepEqual(normalizeStationElement(node), {
    id: 'node/271234',
    name: 'Paris Gare de Lyon',
    lat: 48.8443,
    lon: 2.3744,
    operator: 'SNCF',
    network: 'TER',
    usage: 'main',
    platforms: 26,
  });

  // A way carries its coordinate in `center`.
  assert.equal(
    normalizeStationElement({
      type: 'way',
      id: 9,
      center: { lat: 47.218, lon: -1.553 },
      tags: { railway: 'station', name: 'Nantes' },
    })?.id,
    'way/9',
  );

  // No name, no position, not a station, or the null island: not drawn.
  assert.equal(
    normalizeStationElement({
      type: 'node',
      id: 1,
      lat: 1,
      lon: 1,
      tags: { railway: 'station' },
    }),
    null,
  );
  assert.equal(
    normalizeStationElement({
      type: 'node',
      id: 2,
      tags: { railway: 'station', name: 'X' },
    }),
    null,
  );
  assert.equal(
    normalizeStationElement({
      type: 'node',
      id: 3,
      lat: 1,
      lon: 1,
      tags: { railway: 'halt', name: 'X' },
    }),
    null,
  );
  assert.equal(
    normalizeStationElement({
      type: 'node',
      id: 4,
      lat: 0,
      lon: 0,
      tags: { railway: 'station', name: 'X' },
    }),
    null,
  );
});

test('one station mapped twice is drawn once', () => {
  const node = {
    type: 'node',
    id: 1,
    lat: 48.8443,
    lon: 2.3744,
    tags: { railway: 'station', name: 'Gare de Lyon' },
  };
  const building = {
    type: 'way',
    id: 2,
    center: { lat: 48.8449, lon: 2.3746 },
    tags: { railway: 'station', name: 'Gare de Lyon' },
  };
  // A same-named station about 70 m away is the same place.
  assert.ok(approxMeters(node, building.center) < 300);
  const { records } = normalizeStations([node, building]);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'node/1');

  // A same-named station in another town is a different place.
  const otherTown = {
    type: 'node',
    id: 3,
    lat: 49.1,
    lon: 2.5,
    tags: { railway: 'station', name: 'Gare de Lyon' },
  };
  assert.equal(normalizeStations([node, otherTown]).records.length, 2);
  // Garbage never throws.
  assert.deepEqual(normalizeStations(null), { records: [], saturated: false });
  assert.deepEqual(normalizeStations([null, {}]).records, []);
});

test('a full answer reports itself as limited', () => {
  const elements = Array.from({ length: QUERY_LIMIT }, (_, index) => ({
    type: 'node',
    id: index,
    lat: 48 + index / 1000,
    lon: 2,
    tags: { railway: 'station', name: `Stop ${index}` },
  }));
  const { records, saturated } = normalizeStations(elements);
  assert.equal(records.length, QUERY_LIMIT);
  assert.equal(saturated, true);
  assert.equal(normalizeStations(elements.slice(0, 5)).saturated, false);
});

test('label budget goes to main-line stations first', () => {
  assert.ok(
    stationPriority({ usage: 'main' }) > stationPriority({ usage: 'branch' }),
  );
  assert.ok(
    stationPriority({ usage: 'branch' }) > stationPriority({ usage: null }),
  );
  const entries = [
    createStationOverlayEntry({
      id: 'a',
      position: {},
      name: 'Halt',
      usage: null,
    }),
    createStationOverlayEntry({
      id: 'b',
      position: {},
      name: 'Paris Gare de Lyon',
      usage: 'main',
    }),
    createStationOverlayEntry({
      id: 'c',
      position: {},
      name: 'Branch',
      usage: 'branch',
    }),
  ];
  assert.deepEqual(
    selectStationCohort(entries).map((entry) => entry.id),
    ['b', 'c', 'a'],
  );
  assert.equal(selectStationCohort(entries, 1).length, 1);
  assert.equal(selectStationCohort(entries, 0).length, 0);
  assert.equal(selectStationCohort(null).length, 0);
  // The entry carries the name as its label and the shared collision lane.
  const [first] = selectStationCohort(entries);
  assert.equal(first.title, 'Paris Gare de Lyon');
  assert.equal(first.collisionGroup, 'ambient-label');
  assert.ok(
    selectStationCohort(entries, LABEL_COHORT_LIMIT).length <=
      LABEL_COHORT_LIMIT,
  );
});

test('a click is attributed to this layer only through the namespaced id', () => {
  assert.equal(
    stationIdFromPick('railway-stations:node/271234'),
    'node/271234',
  );
  assert.equal(stationIdFromPick('railway-stations:way/9'), 'way/9');
  // Another layer's marker, a bare OSM id, or nothing at all is not ours.
  assert.equal(stationIdFromPick('bikeshare:city:42'), null);
  assert.equal(stationIdFromPick('flow:node/1'), null);
  assert.equal(stationIdFromPick('railway-stations:'), null);
  assert.equal(stationIdFromPick(null), null);
  assert.equal(stationIdFromPick(42), null);
});

test('the card says what the map records, and never invents the rest', () => {
  const tags = {
    railway: 'station',
    name: 'Paris Gare de Lyon',
    operator: 'SNCF',
    network: 'TER',
    usage: 'main',
    platforms: 26,
  };
  const record = normalizeStationElement({
    type: 'node',
    id: 271234,
    lat: 48.8443,
    lon: 2.3744,
    tags,
  });
  const copy = buildStationSelectionCopy(record);
  assert.equal(copy.title, 'Paris Gare de Lyon');
  assert.deepEqual(copy.details, [
    'Operator SNCF',
    'Network TER',
    'Platforms 26',
    'Mapped in OpenStreetMap · not a live service',
  ]);

  // A sparsely tagged station keeps only the lines it can support.
  const bare = normalizeStationElement({
    type: 'node',
    id: 5,
    lat: 47.2,
    lon: -1.5,
    tags: { railway: 'station', name: 'Nantes' },
  });
  assert.deepEqual(buildStationSelectionCopy(bare).details, [
    'Mapped in OpenStreetMap · not a live service',
  ]);

  // The card is translated by the caller, which is why the default is English.
  const translated = buildStationSelectionCopy(record, (text, values) =>
    text.replace(/\{(\w+)\}/g, (literal, name) => values?.[name] ?? literal),
  );
  assert.ok(translated.details.includes('Operator SNCF'));
});

test('the selected card is protected, unique, and anchored above the marker', () => {
  const copy = { title: 'Nantes', details: ['Operator SNCF'] };
  const entry = createStationSelectedOverlayEntry('node/5', { x: 1 }, copy);
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.selected, true);
  assert.equal(entry.protected, true);
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.priority, Number.MAX_SAFE_INTEGER);
  assert.equal(entry.accent, STATION_SELECTED_COLOR);
  assert.equal(entry.title, 'Nantes');
  assert.deepEqual(entry.details, ['Operator SNCF']);
  assert.equal(entry.placement, 'above');
  assert.equal(entry.interactive, false);
  // No key or no anchor means no card, rather than an entry at the origin.
  assert.equal(createStationSelectedOverlayEntry('', { x: 1 }, copy), null);
  assert.equal(createStationSelectedOverlayEntry('node/5', null, copy), null);
});
