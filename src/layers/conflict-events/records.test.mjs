// src/layers/conflict-events/records.test.mjs
// Pure normalization and mapping — no viewer, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONFLICT_EVENTS,
  normalizeAcledRows,
  normalizeConflictSnapshot,
  normalizeGdeltGeoJson,
} from './records.js';
import { mapAnalystRecord, selectConflictOverlayCohort } from './model.js';

const ACLED_ROW = {
  event_id_cnty: 'UKR1234',
  event_date: '2026-11-03',
  event_type: 'Battles',
  sub_event_type: 'Armed clash',
  actor1: 'Military Forces of Ukraine',
  actor2: 'Military Forces of Russia',
  fatalities: '7',
  latitude: '48.51',
  longitude: '37.68',
  country: 'Ukraine',
};

test('acled: a full row maps every contract field', () => {
  const [row] = normalizeAcledRows([ACLED_ROW]);
  assert.deepEqual(row, {
    stableId: 'UKR1234',
    provider: 'acled',
    lat: 48.51,
    lon: 37.68,
    timeMs: Date.parse('2026-11-03T00:00:00Z'),
    type: 'Battles',
    subType: 'Armed clash',
    actors: 'Military Forces of Ukraine / Military Forces of Russia',
    fatalities: 7,
    country: 'Ukraine',
    sourceUrl: null,
  });
});

test('acled: rows without coordinates are skipped, not fatal', () => {
  const rows = normalizeAcledRows([
    { ...ACLED_ROW, event_id_cnty: 'A', latitude: '', longitude: '' },
    { ...ACLED_ROW, event_id_cnty: 'B' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'B');
});

test('acled: a malformed row fails the whole snapshot', () => {
  assert.equal(normalizeAcledRows([ACLED_ROW, 'nope']), null);
  assert.equal(normalizeAcledRows({ not: 'an array' }), null);
  assert.equal(normalizeAcledRows([{ ...ACLED_ROW, latitude: '999' }]), null);
});

test('acled: duplicate ids collapse to the first occurrence', () => {
  const rows = normalizeAcledRows([ACLED_ROW, ACLED_ROW]);
  assert.equal(rows.length, 1);
});

test('acled: missing fatalities become 0, never NaN', () => {
  const rows = normalizeAcledRows([{ ...ACLED_ROW, fatalities: '' }]);
  assert.equal(rows[0].fatalities, 0);
});

test('acled: accepts the {data: [...]} envelope', () => {
  const rows = normalizeAcledRows({ data: [ACLED_ROW] });
  assert.equal(rows.length, 1);
});

test('gdelt: a point feature maps to a row with no casualty count', () => {
  const payload = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [37.68, 48.51] },
        properties: {
          url: 'https://example.test/story',
          seendate: '20261103T120000Z',
          name: 'Shelling reported',
        },
      },
    ],
  };
  const [row] = normalizeGdeltGeoJson(payload);
  assert.equal(row.stableId, 'https://example.test/story');
  assert.equal(row.provider, 'gdelt');
  assert.equal(row.lat, 48.51);
  assert.equal(row.lon, 37.68);
  assert.equal(row.timeMs, Date.parse('2026-11-03T12:00:00Z'));
  assert.equal(row.fatalities, 0);
  assert.equal(row.sourceUrl, 'https://example.test/story');
});

test('gdelt: non-point geometry and empty coordinates are skipped', () => {
  const rows = normalizeGdeltGeoJson({
    features: [
      { geometry: { type: 'Polygon', coordinates: [] }, properties: {} },
      { geometry: { type: 'Point', coordinates: [] }, properties: {} },
      {
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: {},
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'gdelt-3');
});

test('gdelt: a payload without features fails the snapshot', () => {
  assert.equal(normalizeGdeltGeoJson({}), null);
  assert.equal(normalizeGdeltGeoJson(null), null);
});

test('snapshot: provider selects the normalizer', () => {
  assert.equal(
    normalizeConflictSnapshot([ACLED_ROW], { provider: 'acled' }).length,
    1,
  );
  assert.equal(
    normalizeConflictSnapshot([ACLED_ROW], { provider: 'gdelt' }),
    null,
  );
});

test('snapshot: row count is capped', () => {
  const many = Array.from({ length: MAX_CONFLICT_EVENTS + 25 }, (_, i) => ({
    ...ACLED_ROW,
    event_id_cnty: `ID${i}`,
  }));
  assert.equal(normalizeAcledRows(many).length, MAX_CONFLICT_EVENTS);
});

test('analyst record: full record maps every field', () => {
  const record = mapAnalystRecord({
    id: 'UKR1234',
    lat: 48.51,
    lon: 37.68,
    timeMs: 1_761_000_000_000,
    type: 'Battles',
    subType: 'Armed clash',
    actors: 'A / B',
    fatalities: 7,
    country: 'Ukraine',
    provider: 'acled',
    sourceUrl: null,
  });
  assert.deepEqual(record, {
    id: 'UKR1234',
    lat: 48.51,
    lon: 37.68,
    timeMs: 1_761_000_000_000,
    type: 'Battles',
    subType: 'Armed clash',
    actors: 'A / B',
    fatalities: 7,
    country: 'Ukraine',
    provider: 'acled',
    sourceUrl: null,
  });
});

test('analyst record: missing fields are null and ids fall back', () => {
  const record = mapAnalystRecord({ lat: NaN }, 3);
  assert.equal(record.id, 'CONFLICT-0003');
  assert.equal(record.lat, null);
  for (const [key, value] of Object.entries(record)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value));
  }
});

test('overlay cohort: deadliest first, capped and stable', () => {
  const entries = [
    { id: 'low', priority: 0 },
    { id: 'high', priority: 50 },
    { id: 'mid', priority: 7 },
  ];
  assert.deepEqual(
    selectConflictOverlayCohort(entries, 2).map((e) => e.id),
    ['high', 'mid'],
  );
  assert.deepEqual(selectConflictOverlayCohort(entries, 0), []);
});
