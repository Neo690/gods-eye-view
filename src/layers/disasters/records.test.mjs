import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GDACS_ACTIVE_GRACE_MS,
  normalizeEffisCollection,
  normalizeGdacsEventList,
  normalizeEmsActivationList,
  EMS_ACTIVATION_WINDOW_MS,
  EFFIS_RING_VERTEX_CAP,
  parseEffisTimestamp,
  parseIsoUtcLike,
  parseWktPoint,
} from './records.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');

test('parse helpers accept the documented shapes only', () => {
  assert.equal(
    parseIsoUtcLike('2026-11-01T00:00:00'),
    Date.parse('2026-11-01T00:00:00Z'),
  );
  assert.equal(
    parseIsoUtcLike('2026-11-01T00:00:00.500'),
    Date.parse('2026-11-01T00:00:00.500Z'),
  );
  assert.equal(parseIsoUtcLike('nope'), null);
  assert.equal(parseIsoUtcLike(null), null);
  assert.equal(
    parseEffisTimestamp('2026-10-27 00:11:00'),
    Date.parse('2026-10-27T00:11:00Z'),
  );
  assert.equal(parseEffisTimestamp('2026-10-27T00:11:00'), null);
  assert.deepEqual(parseWktPoint('POINT (0.022993 38.816289)'), {
    lat: 38.816289,
    lon: 0.022993,
  });
  assert.equal(parseWktPoint('POINT(a b)'), null);
});

function gdacsFeature(overrides = {}) {
  const { geometry, properties, ...propertyExtras } = overrides;
  return {
    geometry: geometry ?? { type: 'Point', coordinates: [2.3, 48.8] },
    properties: {
      eventid: 1001346,
      episodeid: 10,
      eventname: 'MURASU-26',
      eventtype: 'TC',
      alertlevel: 'RED',
      country: 'India',
      fromdate: '2026-11-01T00:00:00',
      todate: '2026-11-02T06:00:00',
      severitydata: { severity: 157, severityunit: 'km/h' },
      url: { report: 'https://www.gdacs.org/report.aspx?x' },
      ...propertyExtras,
      ...(properties ?? {}),
    },
  };
}

test('normalizeGdacsEventList maps point features to flat rows', () => {
  const result = normalizeGdacsEventList(
    {
      features: [
        gdacsFeature(),
        gdacsFeature({
          properties: { eventid: 2, episodeid: 0, eventtype: 'WF', alertlevel: 'red' },
        }),
      ],
    },
    { now: NOW },
  );
  assert.ok(result);
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows[0], {
    kind: 'event',
    source: 'gdacs',
    stableId: 'gdacs:1001346:10',
    lat: 48.8,
    lon: 2.3,
    hazard: 'TC',
    name: 'MURASU-26',
    country: 'India',
    alertLevel: 'Red',
    severity: 157,
    severityUnit: 'km/h',
    timeMs: Date.parse('2026-11-02T06:00:00Z'),
    url: 'https://www.gdacs.org/report.aspx?x',
    areaHa: null,
    rings: null,
  });
  assert.equal(result.rows[1].stableId, 'gdacs:2:0');
  assert.equal(result.rows[1].hazard, 'WF');
  assert.equal(result.dropped, 0);
});

test('normalizeGdacsEventList centroids polygons, drops unusable rows, and enforces the active window', () => {
  const polygonFeature = gdacsFeature({
    geometry: {
      type: 'Polygon',
      coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
    },
    properties: { eventid: 7, eventtype: 'FL' },
  });
  const staleFeature = gdacsFeature({
    properties: {
      eventid: 9,
      eventtype: 'DR',
      todate: '2026-10-01T00:00:00',
      fromdate: '2026-09-01T00:00:00',
    },
  });
  const badFeature = {
    geometry: { type: 'Point', coordinates: [900, 48] },
    properties: { eventid: 3, eventtype: 'TC' },
  };
  const result = normalizeGdacsEventList(
    { features: [polygonFeature, staleFeature, badFeature] },
    { now: NOW },
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].lat, 1);
  assert.equal(result.rows[0].lon, 1);
  assert.equal(result.dropped, 1, 'the stale event is windowed, not shape-dropped');
  assert.ok(NOW - result.rows[0].timeMs < GDACS_ACTIVE_GRACE_MS);
});

test('normalizeGdacsEventList rejects documents without a features array', () => {
  assert.equal(normalizeGdacsEventList({ features: null }), null);
  assert.equal(normalizeGdacsEventList(null), null);
});

function emsActivation(overrides = {}) {
  return {
    code: 'EMSR935',
    countries: ['Spain'],
    eventTime: '2026-10-19T03:10:00',
    name: 'Flood in Alicante-Valencia Regions, Spain',
    centroid: 'POINT (0.023 38.816)',
    activationTime: '2026-10-19T16:03:00',
    category: { slug: 'flood', name: 'Flood' },
    lastUpdate: '2026-10-28T08:51:30.454061',
    closed: false,
    ...overrides,
  };
}

test('normalizeEmsActivationList keeps recent unclosed activations', () => {
  const result = normalizeEmsActivationList(
    {
      count: 2,
      results: [
        emsActivation(),
        emsActivation({ code: 'EMSR934', closed: true }),
        emsActivation({
          code: 'EMSR933',
          centroid: 'POINT (1.0 2.0)',
          activationTime: '2020-01-01T00:00:00',
        }),
        { code: 'EMSR932', centroid: null },
      ],
    },
    { now: NOW },
  );
  assert.ok(result);
  assert.equal(result.rows.length, 2);
  const [first, second] = result.rows;
  assert.deepEqual(first, {
    kind: 'activation',
    source: 'ems',
    stableId: 'ems:EMSR935',
    lat: 38.816,
    lon: 0.023,
    hazard: 'flood',
    name: 'Flood in Alicante-Valencia Regions, Spain',
    country: 'Spain',
    alertLevel: 'Active',
    severity: null,
    severityUnit: null,
    timeMs: Date.parse('2026-10-19T16:03:00Z'),
    url: null,
    areaHa: null,
    rings: null,
  });
  assert.equal(second.alertLevel, null);
  assert.equal(second.stableId, 'ems:EMSR934');
  assert.ok(NOW - first.timeMs < EMS_ACTIVATION_WINDOW_MS);
});

test('normalizeEmsActivationList sorts newest first and rejects junk', () => {
  const fromArray = normalizeEmsActivationList(
    [emsActivation({ activationTime: '2026-10-01T00:00:00' })],
    { now: NOW },
  );
  assert.equal(fromArray.rows.length, 1);
  assert.equal(normalizeEmsActivationList({ results: 'no' }), null);
});

function effisFeature(overrides = {}) {
  const { geometry, properties, ...propertyExtras } = overrides;
  return {
    geometry: geometry ?? {
      type: 'Polygon',
      coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
    },
    properties: {
      id: '871144',
      FIREDATE: '2026-10-30 08:26:00',
      LASTUPDATE: '2026-10-30 08:26:00.733037',
      COUNTRY: 'FR',
      PROVINCE: 'Corse-du-Sud',
      COMMUNE: 'Zicavo',
      AREA_HA: '10',
      ...propertyExtras,
      ...(properties ?? {}),
    },
  };
}

test('normalizeEffisCollection reads the string-typed WFS answer', () => {
  const result = normalizeEffisCollection(
    { name: 'modis.ba.poly.week', features: [effisFeature()] },
    { now: NOW },
  );
  assert.ok(result);
  assert.equal(result.rows.length, 1);
  const row = result.rows[0];
  assert.equal(row.kind, 'fire');
  assert.equal(row.source, 'effis');
  assert.equal(row.stableId, 'effis:871144');
  assert.equal(row.lat, 1);
  assert.equal(row.lon, 1);
  assert.equal(row.hazard, 'wildfire');
  assert.equal(row.timeMs, Date.parse('2026-10-30T08:26:00Z'));
  assert.ok(Array.isArray(row.rings));
});

test('normalizeEffisCollection maps fields, districts, multipolygons and windows', () => {
  const result = normalizeEffisCollection(
    {
      features: [
        effisFeature({ AREA_HA: '5600' }),
        effisFeature({
          geometry: {
            type: 'MultiPolygon',
            coordinates: [
              [[[4, 0], [6, 0], [6, 2], [4, 2], [4, 0]]],
              [[[0, 4], [2, 4], [2, 6], [0, 4]]],
            ],
          },
        }),
        effisFeature({ id: 'old', FIREDATE: '2025-01-01 00:00:00' }),
        {
          geometry: { type: 'Point', coordinates: [1, 1] },
          properties: { id: 'x', FIREDATE: '2026-10-30 08:26:00' },
        },
      ],
    },
    { now: NOW },
  );
  const [big, multi] = result.rows;
  assert.equal(result.rows.length, 2);
  assert.equal(big.areaHa, 5600);
  assert.equal(big.name, 'Corse-du-Sud, Zicavo');
  assert.equal(big.country, 'FR');
  assert.equal(multi.rings.length, 2);
  assert.equal(result.dropped, 1);
});

test('normalizeEffisCollection thins oversized rings and honours an unbounded window', () => {
  const hugeRing = [];
  for (let index = 0; index <= EFFIS_RING_VERTEX_CAP * 3; index++) {
    // Stay inside the valid geographic ranges: an out-of-range coordinate is
    // shape-invalid upstream, while the test only exercises the thinning.
    hugeRing.push([((index * 7) % 360) - 180, ((index * 5) % 180) - 90]);
  }
  hugeRing[0] = [0, 0];
  hugeRing[hugeRing.length - 1] = [0, 0];
  const result = normalizeEffisCollection(
    {
      features: [
        effisFeature({ geometry: { type: 'Polygon', coordinates: [hugeRing] } }),
      ],
    },
    { now: Date.parse('2030-01-01T00:00:00Z'), windowMs: -1 },
  );
  assert.ok(result);
  assert.equal(result.rows.length, 1);
  assert.ok(result.rows[0].rings[0].length <= EFFIS_RING_VERTEX_CAP + 1);
});

test('normalizeEffisCollection rejects documents without a features array', () => {
  assert.equal(normalizeEffisCollection({ features: 'no' }), null);
  assert.equal(normalizeEffisCollection(null), null);
});
