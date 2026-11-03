import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeEmscEarthquakeSnapshot,
  parseEmscIsoTime,
} from './records.js';

test('parseEmscIsoTime accepts the FDSN instant shapes EMSC publishes', () => {
  assert.equal(parseEmscIsoTime('2026-11-03T05:40:17.0Z'), 1793684417000);
  assert.equal(
    parseEmscIsoTime('2026-11-03T05:40:17'),
    Date.parse('2026-11-03T05:40:17Z'),
  );
  assert.equal(parseEmscIsoTime('2026-11-03T05:40:17.688559Z'), 1793684417688);
  assert.equal(parseEmscIsoTime(null), null);
  assert.equal(parseEmscIsoTime(1793684417000), null);
  assert.equal(parseEmscIsoTime('not a time'), null);
});

test('normalizeEmsc snapshot reads position and depth from the EMSC properties', () => {
  // Live shape: coordinates carry the depth negated (-60.0) while
  // properties.depth is the positive kilometre value.
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        id: '20261103_0000071',
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [140.81, 35.6, -60.0] },
        properties: {
          unid: '20261103_0000071',
          time: '2026-11-03T05:40:17.0Z',
          flynn_region: 'NEAR EAST COAST OF HONSHU, JAPAN',
          lat: 35.6,
          lon: 140.81,
          depth: 60,
          mag: 5.0,
          magtype: 'mb',
        },
      },
    ],
  };

  const rows = normalizeEmscEarthquakeSnapshot(geojson);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    stableId: '20261103_0000071',
    emscId: '20261103_0000071',
    lon: 140.81,
    lat: 35.6,
    depthKm: 60,
    mag: 5.0,
    place: 'NEAR EAST COAST OF HONSHU, JAPAN',
    time: 1793684417000,
    magtype: 'mb',
  });
});

test('normalizeEmsc snapshot falls back to the geometry when the properties omit the position', () => {
  const geojson = {
    features: [
      {
        id: '20261103_0000099',
        geometry: { type: 'Point', coordinates: [2.35, 48.85, -10] },
        properties: { time: '2026-11-03T05:40:17Z', mag: 3.4 },
      },
    ],
  };

  const rows = normalizeEmscEarthquakeSnapshot(geojson);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lat, 48.85);
  assert.equal(rows[0].lon, 2.35);
  // The negated coordinate depth is flipped back to a positive depth.
  assert.equal(rows[0].depthKm, 10);
  assert.equal(rows[0].place, null);
  assert.equal(rows[0].emscId, '20261103_0000099');
});

test('normalizeEmsc snapshot generates index-based stable ids when the unid and feature id are missing or blank', () => {
  const geojson = {
    features: [
      {
        geometry: { type: 'Point', coordinates: [139.69, 35.68, -25] },
        properties: {
          mag: 3.5,
          flynn_region: 'TOKYO, JAPAN',
          time: '2026-11-03T05:50:17Z',
        },
      },
      {
        id: '',
        geometry: { type: 'Point', coordinates: [-70.66, -33.44, -45] },
        properties: { mag: 5.1, unid: '', time: '2026-11-03T05:51:17Z' },
      },
    ],
  };

  const rows = normalizeEmscEarthquakeSnapshot(geojson);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].stableId, 'event-1');
  assert.equal(rows[0].emscId, null);
  assert.equal(rows[1].stableId, 'event-2');
});

test('normalizeEmsc snapshot filters events below M2.5 without rejecting the feed', () => {
  const geojson = {
    features: [
      {
        id: 'ev-sub',
        geometry: { type: 'Point', coordinates: [10, 20, -5] },
        properties: { mag: 2.49, flynn_region: 'Minor tremor' },
      },
      {
        id: 'ev-null-mag',
        geometry: { type: 'Point', coordinates: [11, 21, -5] },
        properties: { mag: null, flynn_region: 'Uncalculated' },
      },
      {
        id: 'ev-threshold',
        geometry: { type: 'Point', coordinates: [12, 22, -5] },
        properties: { mag: 2.5, flynn_region: 'Threshold event' },
      },
    ],
  };

  const rows = normalizeEmscEarthquakeSnapshot(geojson);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stableId, 'ev-threshold');
  assert.equal(rows[0].mag, 2.5);
});

test('normalizeEmsc snapshot normalizes optional fields to null when omitted or invalid', () => {
  const geojson = {
    features: [
      {
        id: 'ev-sparse',
        geometry: { type: 'Point', coordinates: [-100, 40] },
        properties: { mag: 3.0, flynn_region: 12345, time: 'invalid' },
      },
    ],
  };

  const rows = normalizeEmscEarthquakeSnapshot(geojson);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].depthKm, null);
  assert.equal(rows[0].place, null);
  assert.equal(rows[0].time, null);
  assert.equal(rows[0].magtype, null);
});

test('normalizeEmsc snapshot returns null for malformed structures', () => {
  assert.equal(normalizeEmscEarthquakeSnapshot(null), null);
  assert.equal(normalizeEmscEarthquakeSnapshot(undefined), null);
  assert.equal(normalizeEmscEarthquakeSnapshot({}), null);
  assert.equal(
    normalizeEmscEarthquakeSnapshot({ features: 'not-an-array' }),
    null,
  );
  assert.equal(normalizeEmscEarthquakeSnapshot({ features: null }), null);
});

test('normalizeEmsc snapshot returns null for invalid geometry, position or magnitude', () => {
  const baseFeature = {
    id: 'test',
    geometry: { type: 'Point', coordinates: [0, 0, 0] },
    properties: { mag: 3.0 },
  };

  // Non-Point geometry with unusable properties.
  assert.equal(
    normalizeEmscEarthquakeSnapshot({
      features: [
        {
          ...baseFeature,
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
        },
      ],
    }),
    null,
  );

  // Longitude out of range.
  assert.equal(
    normalizeEmscEarthquakeSnapshot({
      features: [
        {
          ...baseFeature,
          geometry: { type: 'Point', coordinates: [180.1, 0] },
        },
      ],
    }),
    null,
  );
  assert.equal(
    normalizeEmscEarthquakeSnapshot({
      features: [
        {
          ...baseFeature,
          properties: { mag: 3.0, lon: -180.1, lat: 0 },
        },
      ],
    }),
    null,
  );

  // Latitude out of range.
  assert.equal(
    normalizeEmscEarthquakeSnapshot({
      features: [
        {
          ...baseFeature,
          properties: { mag: 3.0, lon: 0, lat: 90.1 },
        },
      ],
    }),
    null,
  );

  // Non-finite coordinate depth with no usable properties fallback.
  assert.equal(
    normalizeEmscEarthquakeSnapshot({
      features: [
        {
          ...baseFeature,
          geometry: { type: 'Point', coordinates: [0, 0, NaN] },
        },
      ],
    }),
    null,
  );

  // Magnitude above the physical ceiling.
  assert.equal(
    normalizeEmscEarthquakeSnapshot({
      features: [{ ...baseFeature, properties: { mag: 10.1 } }],
    }),
    null,
  );

  // Non-object or array properties.
  assert.equal(
    normalizeEmscEarthquakeSnapshot({
      features: [{ ...baseFeature, properties: 'invalid' }],
    }),
    null,
  );
  assert.equal(
    normalizeEmscEarthquakeSnapshot({
      features: [{ ...baseFeature, properties: [] }],
    }),
    null,
  );
});

test('normalizeEmsc snapshot returns null when the feed contains duplicate ids', () => {
  const geojson = {
    features: [
      {
        id: 'duplicate-id',
        geometry: { type: 'Point', coordinates: [0, 0, 0] },
        properties: { mag: 3.0, unid: 'same-unid' },
      },
      {
        id: 'other-id',
        geometry: { type: 'Point', coordinates: [1, 1, -1] },
        properties: { mag: 4.0, unid: 'same-unid' },
      },
    ],
  };

  assert.equal(normalizeEmscEarthquakeSnapshot(geojson), null);
});
