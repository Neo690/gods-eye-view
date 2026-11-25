// src/layers/conflict-events/sourceError.test.mjs
// A failed read must keep the proxy's error code, not just its HTTP status:
// the panel explains `no_key`, `auth`, `upstream` from that code.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConflictEventsSource } from './source.js';

function sourceWith(response) {
  return createConflictEventsSource({
    url: '/api/conflicts',
    fetchImpl: async () => response,
  });
}

test('a 503 carrying no_key surfaces the code, not the status', async () => {
  const source = sourceWith({
    ok: false,
    status: 503,
    json: async () => ({ ok: false, provider: null, error: 'no_key' }),
  });
  await assert.rejects(source.getSnapshot(), (error) => {
    assert.equal(error.code, 'no_key');
    assert.match(error.message, /no_key/);
    return true;
  });
});

test('an auth failure keeps its code too', async () => {
  const source = sourceWith({
    ok: false,
    status: 503,
    json: async () => ({ ok: false, error: 'auth' }),
  });
  await assert.rejects(source.getSnapshot(), (error) => error.code === 'auth');
});

test('a body without an error code falls back to the HTTP status', async () => {
  const source = sourceWith({
    ok: false,
    status: 502,
    json: async () => {
      throw new Error('not json');
    },
  });
  await assert.rejects(
    source.getSnapshot(),
    (error) => error.code === 'http_502' && /HTTP 502/.test(error.message),
  );
});

test('a success that is not ACLED is malformed, never a fallback snapshot', async () => {
  const wrongProvider = sourceWith({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      provider: 'gdelt',
      data: [{ event_id_cnty: 'X', latitude: '1', longitude: '2' }],
    }),
  });
  await assert.rejects(
    wrongProvider.getSnapshot(),
    /Malformed conflicts response/,
  );

  const featureCollection = sourceWith({
    ok: true,
    status: 200,
    json: async () => ({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [30.52, 50.45] },
          properties: { name: 'Shelling reported' },
        },
      ],
    }),
  });
  await assert.rejects(
    featureCollection.getSnapshot(),
    /Malformed conflicts response/,
  );
});

test('a successful read still normalizes events', async () => {
  const source = sourceWith({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      provider: 'acled',
      data: [
        {
          event_id_cnty: 'UKR1',
          event_date: '2026-11-10',
          event_type: 'Battles',
          country: 'Ukraine',
          latitude: '50.45',
          longitude: '30.52',
          fatalities: '23',
        },
      ],
    }),
  });
  const before = Date.now();
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.rows.length, 1);
  assert.equal(snapshot.rows[0].fatalities, 23);
  assert.ok(
    snapshot.generatedAt >= before && snapshot.generatedAt <= Date.now(),
    'a payload without a stamp gets the read time',
  );
});

test('a forced read asks the proxy for refresh=1 and keeps generatedAt', async () => {
  const requests = [];
  const generatedAt = Date.parse('2026-11-20T10:00:00Z');
  const source = createConflictEventsSource({
    url: '/api/conflicts',
    fetchImpl: async (url) => {
      requests.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          provider: 'acled',
          data: [],
          generatedAt,
        }),
      };
    },
  });

  const snapshot = await source.getSnapshot({ force: true });
  assert.equal(requests[0], '/api/conflicts?refresh=1');
  assert.deepEqual(snapshot.rows, []);
  assert.equal(snapshot.generatedAt, generatedAt);
});
