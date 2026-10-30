import test from 'node:test';
import assert from 'node:assert/strict';
import { createFishingEffortSource } from './sources.js';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    headers: { get: () => null },
    body: { cancel: async () => {} },
  };
}

test('the source asks for the viewport and normalises the answer', async () => {
  const asked = [];
  const source = createFishingEffortSource({
    fetchImpl: async (url) => {
      asked.push(url);
      return jsonResponse({
        cells: [{ lat: 10, lon: 20, hours: 4 }],
        totalHours: 4,
        cellCount: 1,
        fetchedAt: 123,
      });
    },
  });
  const answer = await source.getSnapshot({
    west: -10,
    east: 10,
    south: -5,
    north: 5,
    days: 7,
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.cells.length, 1);
  assert.equal(answer.totalHours, 4);
  assert.equal(answer.days, 7);
  assert.match(asked[0], /^\/api\/fishing-effort\?/);
  const params = new URL(asked[0], 'http://localhost').searchParams;
  assert.equal(params.get('west'), '-10');
  assert.equal(params.get('north'), '5');
  assert.equal(params.get('days'), '7');
});

test('a deployment without the token reads as a missing key', async () => {
  const source = createFishingEffortSource({
    fetchImpl: async () => jsonResponse({ error: 'no_key' }, 503),
  });
  const answer = await source.getSnapshot({ west: 0, east: 1, south: 0, north: 1 });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'missing-key');
  assert.deepEqual(answer.cells, []);
});

test('an upstream failure is thrown, never shown as an empty ocean', async () => {
  const source = createFishingEffortSource({
    fetchImpl: async () => jsonResponse({ error: 'x' }, 502),
  });
  await assert.rejects(
    () => source.getSnapshot({ west: 0, east: 1, south: 0, north: 1 }),
    /Fishing effort HTTP 502/,
  );
});
