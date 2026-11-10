import assert from 'node:assert/strict';
import test from 'node:test';

import { createOverpassPlacesSource } from './source.js';

const VIEW = { south: 48.8, west: 2.2, north: 48.9, east: 2.5 };

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function statusConfigured(configured) {
  return async () => jsonResponse({ configured });
}

test('a configured proxy is asked once for the bounded view', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/status')) return jsonResponse({ configured: true });
    return jsonResponse(
      {
        elements: [
          {
            type: 'node',
            id: 42,
            lat: 48.85,
            lon: 2.35,
            tags: { name: 'Café', amenity: 'cafe' },
          },
        ],
      },
      { headers: { 'x-overpass-cache': 'STALE' } },
    );
  };
  const source = createOverpassPlacesSource({ fetchImpl });
  const snapshot = await source.getSnapshot({ bounds: VIEW });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/overpass/status');
  assert.equal(calls[1].url, '/api/overpass');
  assert.equal(calls[1].init.method, 'POST');
  assert.match(calls[1].init.body, /^data=/);
  assert.match(
    decodeURIComponent(calls[1].init.body),
    /48\.80000,2\.20000,48\.90000,2\.50000/,
  );
  assert.equal(snapshot.rows.length, 1);
  assert.deepEqual(snapshot.rows[0].meta, {
    category: 'food',
    kind: 'cafe',
  });
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.truncated, false);
});

test('an unconfigured proxy says so and never sends a query', async () => {
  let posts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/status')) return jsonResponse({ configured: false });
    posts += 1;
    return jsonResponse({ elements: [] });
  };
  const source = createOverpassPlacesSource({ fetchImpl });
  await assert.rejects(source.getSnapshot({ bounds: VIEW }), (error) => {
    assert.equal(error.message, 'Overpass endpoint not configured');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(posts, 0);
});

test('a rate-limited mirror keeps its retry hint', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/status')) return jsonResponse({ configured: true });
    return jsonResponse({}, { status: 429 });
  };
  const source = createOverpassPlacesSource({ fetchImpl });
  await assert.rejects(source.getSnapshot({ bounds: VIEW }), (error) => {
    assert.equal(error.message, 'Overpass rate-limited');
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 60_000);
    return true;
  });
});

test('a query remark is not an authoritative empty map', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/status')) return jsonResponse({ configured: true });
    return jsonResponse({ remark: 'runtime error', elements: [] });
  };
  const source = createOverpassPlacesSource({ fetchImpl });
  await assert.rejects(source.getSnapshot({ bounds: VIEW }), (error) => {
    assert.equal(error.message, 'Overpass could not complete the query');
    assert.equal(error.retryable, false);
    return true;
  });
});

test('a rejected query and a missing view are distinct failures', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/status')) return jsonResponse({ configured: true });
    return jsonResponse({}, { status: 400 });
  };
  const source = createOverpassPlacesSource({ fetchImpl });
  await assert.rejects(source.getSnapshot({ bounds: VIEW }), (error) => {
    assert.equal(error.message, 'Overpass could not complete the query');
    assert.equal(error.retryable, false);
    return true;
  });

  const configured = createOverpassPlacesSource({
    fetchImpl: statusConfigured(true),
  });
  await assert.rejects(
    configured.getSnapshot({ bounds: { south: 1, west: 1, north: 1, east: 2 } }),
    TypeError,
  );
});

test('an unreachable status probe lets the query answer for itself', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/status')) throw new TypeError('offline');
    return jsonResponse({
      elements: [
        {
          type: 'way',
          id: 7,
          center: { lat: 48.86, lon: 2.36 },
          tags: { name: 'Marché', shop: 'supermarket' },
        },
      ],
    });
  };
  const source = createOverpassPlacesSource({ fetchImpl });
  const snapshot = await source.getSnapshot({ bounds: VIEW });
  assert.equal(snapshot.rows[0].label, 'Marché');
});
