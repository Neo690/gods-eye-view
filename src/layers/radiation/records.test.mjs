import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOSE_BANDS,
  READING_LABEL_CELL_DEG,
  READING_LABEL_LIMIT,
  SAFECAST_CPM_PER_USVH,
  doseBand,
  formatDose,
  selectReadingCohort,
  normalizeBfsSnapshot,
  normalizeCanadaSnapshot,
  normalizeRadiationSnapshot,
  normalizeRadmonSnapshot,
  normalizeSafecastSnapshot,
  normalizeSpaceReadings,
  normalizeUradmonitorSnapshot,
  readingsInView,
} from './records.js';

const feature = (lon, lat, properties) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties,
});

test('dose bands cover every non-negative reading once', () => {
  assert.equal(doseBand(0).id, 'background');
  assert.equal(doseBand(0.099).id, 'background');
  assert.equal(doseBand(0.1).id, 'normal');
  assert.equal(doseBand(0.5).id, 'elevated');
  assert.equal(doseBand(12).id, 'high');
  assert.equal(doseBand(-1), null);
  assert.equal(doseBand(Number.NaN), null);
  // The top band is open-ended, so nothing valid falls outside the legend.
  assert.equal(Number.isFinite(DOSE_BANDS.at(-1).max), false);
});

test('BfS hourly values are kept in µSv/h and unplaceable rows are dropped', () => {
  const rows = normalizeBfsSnapshot({
    type: 'FeatureCollection',
    features: [
      feature(10.8, 50.09, {
        kenn: '096741303',
        name: 'Ebern',
        value: 0.123,
        end_measure: '2026-10-24T20:00:00Z',
      }),
      // No geometry: cannot be drawn.
      {
        type: 'Feature',
        geometry: null,
        properties: { kenn: 'x', value: 0.2 },
      },
      feature(200, 10, { kenn: 'bad-lon', value: 0.2 }),
      feature(10, 10, { kenn: 'negative', value: -0.1 }),
    ],
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: '096741303',
    network: 'bfs',
    name: 'Ebern',
    lat: 50.09,
    lon: 10.8,
    usvh: 0.123,
    at: '2026-10-24T20:00:00.000Z',
  });
  assert.equal(normalizeBfsSnapshot({}, {}), null);
});

test('Health Canada nSv/h readings become µSv/h', () => {
  const rows = normalizeCanadaSnapshot({
    features: [
      feature(-79.061, 43.817, {
        OBJECTID: 5249,
        location_name: '1000_10_43.8173_-79.0614',
        latest_value_nSvHr: 29,
        time: 1792872900000,
      }),
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usvh, 0.029);
  assert.equal(rows[0].network, 'canada');
  assert.equal(rows[0].at, new Date(1792872900000).toISOString());
});

test('Safecast counts are converted and old volunteer rows are excluded', () => {
  const now = Date.parse('2026-10-24T21:00:00Z');
  const rows = normalizeSafecastSnapshot(
    [
      {
        id: 1,
        value: SAFECAST_CPM_PER_USVH,
        unit: 'cpm',
        latitude: 48.85,
        longitude: 2.35,
        captured_at: '2026-10-24T20:00:00Z',
      },
      {
        id: 2,
        value: 30,
        unit: 'cpm',
        latitude: 35.6,
        longitude: 139.7,
        captured_at: '2022-03-18T08:36:20Z',
      },
      {
        id: 3,
        value: 0.2,
        unit: 'µSv/h',
        latitude: 51.5,
        longitude: -0.12,
        captured_at: '2026-10-24T20:30:00Z',
      },
    ],
    { now },
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['1', '3'],
  );
  assert.equal(rows[0].usvh, 1);
  assert.equal(rows[0].estimated, true, 'a cpm-derived dose is an estimate');
  assert.equal(rows[1].usvh, 0.2);
  assert.equal(rows[1].estimated, undefined);
});

/** The combined-list shape: one array of parallel columns per station. */
const radmonSnapshot = ({
  users,
  names,
  cpms,
  statuses,
  lats,
  lons,
  factors,
  at,
}) =>
  structuredClone([
    users,
    names,
    [],
    [],
    [],
    [],
    [],
    cpms,
    statuses,
    users.map((_, index) => index),
    lats,
    lons,
    users.length,
    factors,
    at,
  ]);

test('radmon station counts become µSv/h with their own factor', () => {
  const rows = normalizeRadmonSnapshot(
    radmonSnapshot({
      users: ['4Hz', 'dormant-one', 'experiment-one', 'no-factor'],
      names: ['Rivas-Vaciamadrid', 'Offline', 'Experiment', 'NoFactor'],
      cpms: ['20.4', '10', '900', '12'],
      statuses: ['0', '1', '2', '0'],
      lats: ['40.3783', '40', '41', '42'],
      lons: ['-3.53188', '-3', '-4', '-5'],
      factors: ['0.0057', '0.0057', '0.0057', '0'],
      at: 1792876968,
    }),
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['4Hz'],
    'dormant, experiment-mode and unusable rows are not background readings',
  );
  assert.equal(rows[0].network, 'radmon');
  assert.equal(rows[0].name, 'Rivas-Vaciamadrid');
  assert.equal(rows[0].usvh, 20.4 * 0.0057);
  assert.equal(rows[0].at, new Date(1792876968000).toISOString());
  assert.equal(rows[0].estimated, true, 'a count-derived dose is an estimate');
  assert.equal(normalizeRadmonSnapshot({ stations: [] }), null);
  assert.equal(normalizeRadmonSnapshot([]), null);
});

test('uRADMonitor units are read only while online, fresh and placeable', () => {
  const now = Date.parse('2026-10-24T21:00:00Z');
  const unit = (overrides = {}) => ({
    id: '82000466',
    status: 1,
    last_cpm: 20,
    factor: 0.01,
    timelast: now / 1000 - 600,
    latitude: 48.85,
    longitude: 2.35,
    city: 'Paris',
    country: 'FR',
    ...overrides,
  });
  const rows = normalizeUradmonitorSnapshot(
    [
      unit(),
      // The unit stopped uploading: status is null.
      unit({ id: 'offline', status: null }),
      // Fresh unit whose count rate has not arrived yet.
      unit({ id: 'no-counts', last_cpm: null, last_cpm2: null }),
      // Second tube reports when the first one does not.
      unit({ id: 'two-tubes', last_cpm: null, last_cpm2: 40 }),
      // Last upload is older than the freshness window.
      unit({ id: 'stale', timelast: now / 1000 - 7 * 3600 }),
      // A factor that cannot be a cpm-to-µSv/h conversion.
      unit({ id: 'bad-factor', factor: 4 }),
      unit({ id: 'unplaced', latitude: null }),
    ],
    { now },
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['82000466', 'two-tubes'],
  );
  assert.equal(rows[0].network, 'uradmonitor');
  assert.equal(rows[0].name, 'Paris, FR');
  assert.equal(rows[0].usvh, 0.2);
  assert.equal(rows[0].estimated, true, 'a cpm-derived dose is an estimate');
  assert.equal(rows[1].usvh, 0.4);
  assert.equal(normalizeUradmonitorSnapshot([]).length, 0);
  assert.equal(normalizeUradmonitorSnapshot({ error: 'no' }), null);
});

test('space radiation takes the newest ≥10 MeV flux and Kp, and bands them', () => {
  const calm = normalizeSpaceReadings({
    protons: [
      { time_tag: '2026-10-24T20:00:00Z', flux: 0.4, energy: '>=10 MeV' },
      { time_tag: '2026-10-24T20:00:00Z', flux: 99, energy: '>=1 MeV' },
    ],
    kp: [{ time_tag: '2026-10-24T20:00:00', kp_index: 2 }],
  });
  assert.equal(calm.protonFlux, 0.4, 'only the ≥10 MeV channel is read');
  assert.equal(calm.kp, 2);
  assert.equal(calm.band, 'calm');

  const storm = normalizeSpaceReadings({
    protons: [
      { time_tag: '2026-10-24T20:00:00Z', flux: 25, energy: '>=10 MeV' },
    ],
    kp: [{ time_tag: '2026-10-24T20:00:00', kp_index: 3 }],
  });
  assert.equal(storm.band, 'storm');

  const kpStorm = normalizeSpaceReadings({
    protons: [
      { time_tag: '2026-10-24T20:00:00Z', flux: 0.2, energy: '>=10 MeV' },
    ],
    kp: [{ time_tag: '2026-10-24T20:05:00', kp_index: 5 }],
  });
  assert.equal(kpStorm.band, 'storm');
  assert.equal(normalizeSpaceReadings({}), null);
});

test('a server snapshot keeps known networks only and rejects undated answers', () => {
  const snapshot = normalizeRadiationSnapshot({
    fetchedAt: 1792900000000,
    stations: [
      { id: 'a', network: 'bfs', name: 'Ebern', lat: 50, lon: 10, usvh: 0.1 },
      { id: 'b', network: 'unknown-network', lat: 50, lon: 10, usvh: 0.1 },
      { id: 'c', network: 'canada', lat: 120, lon: 10, usvh: 0.1 },
    ],
    space: { band: 'calm' },
    sources: [{ id: 'bfs', ok: true, count: 1 }],
  });
  assert.deepEqual(
    snapshot.stations.map((row) => row.id),
    ['a'],
  );
  assert.equal(snapshot.fetchedAt, 1792900000000);
  assert.equal(snapshot.space.band, 'calm');
  assert.equal(normalizeRadiationSnapshot({ stations: [] }), null);
});

test('the in-view list is worst-first, bounded, and clipped to the camera', () => {
  const rows = [
    { id: '1', lon: 10, lat: 50, usvh: 0.1 },
    { id: '2', lon: 10.1, lat: 50.1, usvh: 2.4 },
    { id: '3', lon: 10.2, lat: 50.2, usvh: 0.4 },
    { id: '4', lon: 100, lat: 10, usvh: 9 },
  ];
  const inView = readingsInView(
    rows,
    { west: 9, south: 49, east: 11, north: 51 },
    2,
  );
  assert.deepEqual(
    inView.map((row) => row.id),
    ['2', '3'],
  );
  assert.equal(readingsInView(rows, null, 10).length, 4);
});

test('dose text is precise enough to separate background from an elevation', () => {
  assert.equal(formatDose(0.1234), '0.123');
  assert.equal(formatDose(1.26), '1.3');
  assert.equal(formatDose(12.4), '12');
  assert.equal(formatDose(null), '—');
});

test('labels keep the strongest reading per cell, never a stack on one mine', () => {
  const rows = [
    // Three stations inside one 4° cell: only the strongest is labelled.
    { id: 'a', lon: 10.1, lat: 50.1, usvh: 0.1 },
    { id: 'b', lon: 11.2, lat: 50.8, usvh: 2.4 },
    { id: 'c', lon: 10.4, lat: 51.9, usvh: 1.1 },
    // Another cell, far away.
    { id: 'd', lon: -70, lat: 10, usvh: 0.2 },
    { id: 'e', lon: -69, lat: 11, usvh: 0.15 },
    // No usable position or value: never labelled.
    { id: 'f', lon: null, lat: 50, usvh: 9 },
    { id: 'g', lon: 10, lat: 50, usvh: null },
  ];
  const cohort = selectReadingCohort(rows);
  assert.deepEqual(
    cohort.map((row) => row.id),
    ['b', 'd'],
    'one per cell, strongest first',
  );
  assert.equal(selectReadingCohort(rows, { limit: 1 }).length, 1);
  assert.deepEqual(selectReadingCohort(rows, { limit: 0 }), []);
  assert.deepEqual(selectReadingCohort([]), []);
  assert.equal(READING_LABEL_LIMIT, 24);
  assert.equal(READING_LABEL_CELL_DEG, 4);
  // A tie inside a cell resolves on the id, so two snapshots agree.
  const tied = [
    { id: 'y', lon: 1, lat: 1, usvh: 1 },
    { id: 'x', lon: 2, lat: 2, usvh: 1 },
  ];
  assert.equal(selectReadingCohort(tied)[0].id, 'x');
});
