// src/data/emscSeismic.test.mjs
// Focused tests for the EMSC layer wiring and its analyst-record mapper,
// overlay presentation and real refresh lifecycle. Mirror of
// src/data/earthquakes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  EMSC_OVERLAY_COHORT_LIMIT,
  createEmscOverlayEntry,
  createEmscSeismicLayer,
  mapAnalystRecord,
  selectEmscOverlayCohort,
} from './emscSeismic.js';
import { createEmscEarthquakeSource } from '../layers/emscSeismic/source.js';

const FULL_RAW = {
  id: '20261103_0000071',
  mag: 5.0,
  place: 'NEAR EAST COAST OF HONSHU, JAPAN',
  time: 1_793_684_417_000,
  depth: 60,
  lat: 35.6,
  lon: 140.81,
};

test('emsc analyst record: full record maps every contract field', () => {
  const r = mapAnalystRecord(FULL_RAW, 3);
  assert.deepEqual(r, {
    id: '20261103_0000071',
    magnitude: 5.0,
    depthKm: 60,
    lat: 35.6,
    lon: 140.81,
    timeMs: 1_793_684_417_000,
    place: 'NEAR EAST COAST OF HONSHU, JAPAN',
  });
});

test('emsc analyst record: missing unid falls back to the index-based id', () => {
  assert.equal(mapAnalystRecord({ ...FULL_RAW, id: null }, 3).id, 'QEMSC-0003');
  assert.equal(mapAnalystRecord({ ...FULL_RAW, id: '  ' }, 41).id, 'QEMSC-0041');
  assert.equal(mapAnalystRecord(undefined).id, 'QEMSC-0000');
});

test('emsc analyst record: missing fields become null, never NaN/undefined', () => {
  const r = mapAnalystRecord({ id: 'u1', mag: NaN, depth: undefined, place: '' }, 0);
  assert.equal(r.magnitude, null);
  assert.equal(r.depthKm, null);
  assert.equal(r.place, null);
  for (const [key, value] of Object.entries(r)) {
    assert.notEqual(value, undefined, `${key} must not be undefined`);
    if (typeof value === 'number')
      assert.ok(Number.isFinite(value), `${key} must not be NaN`);
  }
});

test('emsc analyst record: output is JSON-safe (no Cesium types)', () => {
  const r = mapAnalystRecord(FULL_RAW, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('emsc overlay copy keeps source-side magnitude formatting and bounded priority', () => {
  const position = Cesium.Cartesian3.fromDegrees(140.81, 35.6);
  const entry = createEmscOverlayEntry({
    id: '20261103_0000071',
    position,
    magnitude: 5.04,
    accent: '#ff0000',
  });
  assert.equal(entry.title, 'M5.0');
  assert.equal(entry.position, position);
  assert.equal(entry.variant, 'label');
  assert.equal(entry.paintLane, 'ambient-label');
  assert.equal(entry.collisionGroup, 'ambient-label');
  assert.equal(entry.protected, undefined);
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);

  const entries = Array.from(
    { length: EMSC_OVERLAY_COHORT_LIMIT + 20 },
    (_, index) => ({ id: `quake-${String(index).padStart(3, '0')}`, priority: index }),
  );
  const cohort = selectEmscOverlayCohort(entries);
  assert.equal(cohort.length, EMSC_OVERLAY_COHORT_LIMIT);
  assert.equal(cohort[0].id, `quake-${EMSC_OVERLAY_COHORT_LIMIT + 19}`);
  assert.equal(cohort.at(-1).id, 'quake-020');
});

const EMSC_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      id: '20261103_0000071',
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [140.81, 35.6, -60] },
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
    {
      id: '20261103_0000072',
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [2.35, 48.85, -5] },
      properties: {
        unid: '20261103_0000072',
        time: '2026-11-03T05:55:00.0Z',
        flynn_region: 'FRANCE',
        lat: 48.85,
        lon: 2.35,
        depth: 5,
        mag: 2.6,
      },
    },
  ],
};

test('real EMSC lifecycle publishes host labels, entities and analyst records, then goes quiet when disabled', async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  const dataSources = [];
  const host = {
    calls: [],
    setEntries(...args) {
      this.calls.push(['entries', ...args]);
    },
    setVisible(...args) {
      this.calls.push(['visible', ...args]);
    },
    clearSource(...args) {
      this.calls.push(['clear', ...args]);
    },
  };
  const viewer = {
    dataSources: {
      add(dataSource) {
        dataSources.push(dataSource);
        return dataSource;
      },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => EMSC_FIXTURE,
    };
  };
  const layer = createEmscSeismicLayer({
    source: createEmscEarthquakeSource({
      now: () => new Date(Date.parse('2026-11-03T08:00:00.000Z')),
    }),
    overlayHost: host,
  });
  try {
    layer.init(viewer);
    layer.enable(viewer);
    const updated = await layer.update(viewer);
    assert.equal(updated, true);

    // The standalone source requested the 24h M2.5+ json window.
    assert.equal(fetchCalls.length, 1);
    const requested = new URL(fetchCalls[0]);
    assert.equal(requested.searchParams.get('format'), 'json');
    assert.equal(requested.searchParams.get('minmagnitude'), '2.5');
    assert.equal(requested.searchParams.get('endtime'), '2026-11-03T08:00:00');
    assert.equal(requested.searchParams.get('starttime'), '2026-11-02T08:00:00');

    // Host labels published for the cohort of two features.
    const entryCall = host.calls.find(([kind]) => kind === 'entries');
    assert.ok(entryCall);
    assert.equal(entryCall[1], 'emsc-seismic');
    assert.equal(entryCall[2].length, 2);

    // Both entities exist with their analyst seam properties.
    const dataSource = dataSources[0];
    assert.ok(dataSource);
    assert.equal(dataSource.entities.values.length, 2);
    const strong = dataSource.entities.values.find(
      (e) => e.id === 'earthquake:emsc:20261103_0000071',
    );
    assert.ok(strong);
    const now = Cesium.JulianDate.now();
    assert.equal(strong.properties.emscId.getValue(now), '20261103_0000071');
    assert.equal(strong.properties.mag.getValue(now), 5.0);
    assert.equal(strong.properties.depth.getValue(now), 60);

    const analyst = layer.getAnalystRecords();
    assert.equal(analyst.length, 2);
    // lat/lon are read back through a Cartesian round-trip, so compare the
    // exact scalars and only require the angles to round-trip to within
    // double precision.
    const record = analyst.find((r) => r.id === '20261103_0000071');
    assert.deepEqual(
      {
        id: record.id,
        magnitude: record.magnitude,
        depthKm: record.depthKm,
        timeMs: record.timeMs,
        place: record.place,
      },
      {
        id: '20261103_0000071',
        magnitude: 5.0,
        depthKm: 60,
        timeMs: 1_793_684_417_000,
        place: 'NEAR EAST COAST OF HONSHU, JAPAN',
      },
    );
    assert.ok(Math.abs(record.lat - 35.6) < 1e-9);
    assert.ok(Math.abs(record.lon - 140.81) < 1e-9);
    const stats = layer.getStats();
    assert.equal(stats.count, 2);
    assert.equal(stats.error, null);

    // Disabled layers hold no analyst records even if entities linger.
    layer.disable(viewer);
    assert.deepEqual(layer.getAnalystRecords(), []);
    // The host was cleared for the disabled source id.
    assert.ok(host.calls.some(([kind, id]) => kind === 'clear' && id === 'emsc-seismic'));
  } finally {
    layer.destroy(viewer);
    assert.equal(dataSources.length, 0);
    globalThis.fetch = originalFetch;
  }
});
