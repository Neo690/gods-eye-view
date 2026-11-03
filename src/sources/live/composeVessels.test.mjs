import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AISCAST_FEED_LABEL,
  composeVesselSources,
  createAiscastVesselSource,
  mergeVesselSnapshots,
} from './composeVessels.js';
import { LiveSourceError } from './contract.js';

function fetcher(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(calls.length ? calls[calls.length - 1] : null, calls);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function ok(payload) {
  return { ok: true, status: 200, headers: new Map(), json: async () => payload };
}

function notFound() {
  return { ok: false, status: 404, headers: new Map(), json: async () => null };
}

test('unconfigured route: one request, then the source stops fetching', async () => {
  const fetchImpl = fetcher(() => ok({ configured: false, rows: [] }));
  const source = createAiscastVesselSource({ fetchImpl });
  const first = await source.getSnapshot({}, {});
  assert.equal(first.records.length, 0);
  assert.equal(first.source, AISCAST_FEED_LABEL);
  assert.equal(first.transportStatus, 'absent');
  assert.equal(source.state, 'absent');
  const second = await source.getSnapshot({}, {});
  assert.equal(second.transportStatus, 'absent');
  assert.equal(fetchImpl.calls.length, 1, 'no extra request after absent');
});

test('a missing route (404) is the same honest absence', async () => {
  const fetchImpl = fetcher(() => notFound());
  const source = createAiscastVesselSource({ fetchImpl });
  const snapshot = await source.getSnapshot({}, {});
  assert.equal(source.state, 'absent');
  assert.deepEqual(snapshot.records, []);
  assert.equal(snapshot.transportStatus, 'unavailable');
});

test('a configured route reports active with the aiscast label and transport status', async () => {
  const fetchImpl = fetcher(() =>
    ok({
      source: 'Aiscast',
      configured: true,
      status: 'live',
      rows: [
        {
          mmsi: '244110290',
          name: 'PORTA',
          lat: 52.5,
          lon: 4.0,
          speed: 9.5,
          course: 180,
          heading: 182,
          last_position_UTC: '2026-01-14T17:40:00.000Z',
          last_position_epoch: 1768412400,
        },
      ],
      newestPositionAtMs: Date.parse('2026-01-14T17:40:00.000Z'),
    }),
  );
  const source = createAiscastVesselSource({ fetchImpl });
  const snapshot = await source.getSnapshot({}, {});
  assert.equal(source.state, 'active');
  assert.equal(snapshot.source, 'Aiscast');
  assert.equal(snapshot.transportStatus, 'live');
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].id, '244110290');
  assert.equal(snapshot.records[0].speedMps, 9.5 * 0.514444);
});

test('merge leaves a primary-only snapshot untouched', () => {
  const primary = { records: [{ id: '111' }], source: 'Vessels', observedAtMs: 5 };
  assert.deepEqual(mergeVesselSnapshots(primary, { records: [], source: 'Aiscast' }), primary);
});

test('merge adds extra-only records labelled with the extra source only', () => {
  const primary = { records: [{ id: '111' }], source: 'Vessels', observedAtMs: 5 };
  const extra = {
    records: [{ id: '209', latitude: 43.0, longitude: 6.0 }],
    source: 'Aiscast',
    observedAtMs: 7,
  };
  const merged = mergeVesselSnapshots(primary, extra);
  assert.equal(merged.source, 'Vessels + Aiscast');
  assert.equal(merged.records.length, 2);
  assert.deepEqual(merged.records[0], { id: '111' });
  assert.deepEqual(merged.records[1].sources, ['Aiscast']);
  assert.equal(merged.observedAtMs, 7);
});

test('merge keeps the newest observation for a vessel both feeds carry', () => {
  const primary = {
    records: [{ id: '111', latitude: 50.0, observedAtMs: 200 }],
    source: 'Vessels',
    observedAtMs: 200,
  };
  const extra = {
    records: [
      { id: '111', latitude: 50.2, observedAtMs: 300 },
      { id: '111', latitude: 50.3, observedAtMs: 100 },
    ],
    source: 'Aiscast',
    observedAtMs: 300,
  };
  const merged = mergeVesselSnapshots(primary, extra);
  assert.equal(merged.records.length, 1);
  assert.equal(merged.records[0].latitude, 50.2);
  assert.deepEqual(merged.records[0].sources, ['Vessels', 'Aiscast']);
});

test('a timeless extra record loses the seat to the primary record', () => {
  const primary = {
    records: [{ id: '111', latitude: 50.0 }],
    source: 'Vessels',
    observedAtMs: null,
  };
  const extra = {
    records: [{ id: '111', latitude: 99.9 }],
    source: 'Aiscast',
    observedAtMs: null,
  };
  const merged = mergeVesselSnapshots(primary, extra);
  assert.equal(merged.records[0].latitude, 50.0);
});

test('the compose feeds exactly what the primary gives when the extra is absent', async () => {
  const primary = {
    label: 'Vessels',
    getSnapshot: async () => ({ records: [{ id: '111' }], source: 'Vessels' }),
  };
  const extraRequests = { count: 0 };
  const extra = {
    state: 'absent',
    getSnapshot: async () => {
      extraRequests.count += 1;
      return { records: [], source: 'Aiscast' };
    },
  };
  const composed = composeVesselSources({ primary, extra });
  const snapshot = await composed.getSnapshot({}, {});
  assert.equal(extraRequests.count, 0);
  assert.equal(snapshot.source, 'Vessels');
});

test('the compose folds the extra in when the primary is healthy', async () => {
  const primary = {
    label: 'Vessels',
    getSnapshot: async () => ({
      records: [{ id: '111' }],
      source: 'Vessels',
      observedAtMs: 5,
    }),
    getTrack: async () => ({ records: [] }),
  };
  const fetchImpl = fetcher(() =>
    ok({ configured: true, status: 'live', rows: [], newestPositionAtMs: null }),
  );
  const composed = composeVesselSources({
    primary,
    extra: createAiscastVesselSource({ fetchImpl }),
  });
  const snapshot = await composed.getSnapshot({}, {});
  // Empty extra rows are folded as a no-op: the primary identity stays.
  assert.deepEqual(snapshot.records, [{ id: '111' }]);
  await composed.getTrack('111', {});
  assert.equal(fetchImpl.calls.length, 1);
});

test('the compose falls back to the extra picture when the primary errors', async () => {
  const primary = {
    label: 'Vessels',
    getSnapshot: async () => {
      throw new LiveSourceError('unavailable', 'feed down');
    },
  };
  const fetchImpl = fetcher(() =>
    ok({
      configured: true,
      status: 'live',
      rows: [
        {
          mmsi: '235',
          lat: 1.0,
          lon: 2.0,
          last_position_epoch: 1768412700,
        },
      ],
      newestPositionAtMs: 1768412700000,
    }),
  );
  const composed = composeVesselSources({
    primary,
    extra: createAiscastVesselSource({ fetchImpl }),
  });
  const snapshot = await composed.getSnapshot({}, {});
  assert.equal(snapshot.source, 'Aiscast');
  assert.equal(snapshot.records.length, 1);
  assert.match(snapshot.coverage, /primary AIS feed unavailable/);
  assert.ok(snapshot.primaryError);
});

test('the compose keeps throwing when primary failed and the extra has nothing', async () => {
  const primary = {
    label: 'Vessels',
    getSnapshot: async () => {
      throw new LiveSourceError('unavailable', 'feed down');
    },
  };
  const composed = composeVesselSources({
    primary,
    // Theistic extra with nothing usable — behaves like absence.
    extra: { state: 'unknown', getSnapshot: async () => ({ records: [] }) },
  });
  await assert.rejects(() => composed.getSnapshot({}, {}), /feed down/);
});
