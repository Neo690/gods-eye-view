import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AISCAST_MAX_BODY_BYTES,
  AISCAST_STALE_MS,
  normalizeAiscastFeatureCollection,
  parseAiscastUrl,
  createAiscastHandler,
} from './aiscast.js';

class RecordingResponse {
  constructor(method = 'GET') {
    this.method = method;
    this.statusCode = 0;
    this.headers = new Map();
    this.body = '';
    this.ended = false;
  }

  setHeader(name, value) {
    this.headers.set(name, value);
  }

  end(chunk) {
    if (typeof chunk === 'string') this.body = chunk;
    this.ended = true;
  }
}

function handlerWithDocument(document, { MS_ERRNO } = {}) {
  let documentCalls = 0;
  const documentFetcher = async () => {
    documentCalls += 1;
    if (MS_ERRNO === 'unreachable')
      throw Object.assign(new Error('dns'), { code: 'UNREACHABLE' });
    return JSON.stringify(document);
  };
  return {
    handle: createAiscastHandler({
      urlValue: 'http://127.0.0.1:8080/v1/vessels',
      documentFetcher,
    }).handle,
    get documentCalls() {
      return documentCalls;
    },
  };
}

// The newest position rides one minute under the reference instant, so a
// snapshot taken at that instant reads live and an hour later reads stale.
const NEWEST_AT_MS = Date.parse('2026-01-14T18:29:00Z');

function parsedFeatureCollection({ newestAtMs = NEWEST_AT_MS } = {}) {
  const newestIso = new Date(newestAtMs).toISOString();
  // 2026-01-14T16:00:00Z for the default newest-at instant.
  const olderEpoch = Math.floor(newestAtMs / 1000) - 8940;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-1.5, 47.2] },
        properties: {
          mmsi: '205431000',
          name: 'AUSTRAL',
          imo: '9348762',
          type: 'cargo',
          destination: 'LE HAVRE',
          sog: 12.4,
          cog: 274.0,
          heading: 271,
          time_utc: newestIso,
        },
      },
      {
        // Numeric-string MMSI AND explicit last_position_epoch fallback.
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [2.35, 48.85] },
        properties: {
          mmsi: 227992280,
          ship_name: 'SEINE MARIN',
          last_position_epoch: olderEpoch,
        },
      },
      {
        // Non-Point geometry and text mmsi are both skipped.
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
        properties: { mmsi: '123456789' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-0.01, 40.01] },
        properties: { mmsi: 'abcdef', name: 'no digits' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [200, 91] },
        properties: { mmsi: '999888777', name: 'out of range' },
      },
    ],
  };
}

test('parseAiscastUrl accepts a local http URL and returns it normalized', () => {
  const parsed = parseAiscastUrl('  http://127.0.0.1:8080/v1/vessels ');
  assert.equal(parsed.reason, undefined);
  assert.equal(parsed.url, 'http://127.0.0.1:8080/v1/vessels/');
});

test('parseAiscastUrl default port is scheme-appropriate', () => {
  const parsed = parseAiscastUrl('http://localhost/path');
  assert.equal(parsed.reason, undefined);
  assert.equal(parsed.url, 'http://localhost:80/path/');
});

test('parseAiscastUrl rejects everything the ingester gate refuses', () => {
  const rejected = [
    '',
    null,
    3,
    'notaurl',
    'ftp://127.0.0.1/x',
    'http://user:pass@127.0.0.1/x',
    'https://vessels.example.com/api?only=a%20gate',
    'https://127.0.0.1/api#trailing',
    'https://public.example.com/api',
  ];
  for (const value of rejected) {
    const parsed = parseAiscastUrl(value);
    assert.ok(parsed.reason, `expected ${value} to be rejected`);
    assert.equal(parsed.url, undefined);
  }
});

test('parseAiscastUrl accepts local mDNS and private-range hosts', () => {
  for (const host of ['10.10.10.10', '192.168.1.40:8080', 'gev.local']) {
    const parsed = parseAiscastUrl(`http://${host}/v1/vessels`);
    assert.equal(parsed.reason, undefined, `expected ${host} to be accepted`);
  }
});

test('normalizeAiscastFeatureCollection flattens features to the /api/vessels row shape', () => {
  const now = Date.parse('2026-01-14T18:30:00Z');
  const result = normalizeAiscastFeatureCollection(parsedFeatureCollection(), { now });
  assert.deepEqual(result.rows[0], {
    mmsi: '205431000',
    name: 'AUSTRAL',
    lat: 47.2,
    lon: -1.5,
    imo: '9348762',
    type: 'cargo',
    destination: 'LE HAVRE',
    speed: 12.4,
    course: 274.0,
    heading: 271,
    last_position_UTC: new Date(NEWEST_AT_MS).toISOString(),
    last_position_epoch: Math.floor(NEWEST_AT_MS / 1000),
  });
  assert.equal(result.rows[1].mmsi, '227992280');
  assert.equal(result.rows[1].name, 'SEINE MARIN');
  assert.equal(result.rows[1].last_position_UTC, '2026-01-14T16:00:00.000Z');
  assert.equal(result.rows.length, 2);
  assert.equal(result.status, 'live');
  assert.equal(result.newestPositionAtMs, NEWEST_AT_MS);
});

test('normalizeAiscastFeatureCollection marks an old explicit document stale', () => {
  const now = Date.parse('2026-01-14T20:30:00Z');
  const result = normalizeAiscastFeatureCollection(
    parsedFeatureCollection({ newestAtMs: Date.parse('2026-01-14T17:00:00Z') }),
    { now },
  );
  assert.equal(result.status, 'stale');
});

test('normalizeAiscastFeatureCollection keeps a featureless collection as live', () => {
  const result = normalizeAiscastFeatureCollection({
    type: 'FeatureCollection',
    features: [],
  });
  assert.deepEqual(result.rows, []);
  assert.equal(result.rawFeatureCount, 0);
  assert.equal(result.status, 'live');
  assert.equal(result.newestPositionAtMs, null);
});

test('normalizeAiscastFeatureCollection sorts rows newest first', () => {
  const document = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { mmsi: '111', last_position_epoch: 100 },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { mmsi: '222', last_position_epoch: 300 },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { mmsi: '333' },
      },
    ],
  };
  const result = normalizeAiscastFeatureCollection(document);
  assert.deepEqual(
    result.rows.map((row) => row.mmsi),
    ['222', '111', '333'],
  );
});

test('an unconfigured server answers configured:false without fetching', async () => {
  let fetchCalls = 0;
  const { handle } = createAiscastHandler({
    urlValue: '',
    documentFetcher: async () => {
      fetchCalls += 1;
      return '{}';
    },
  });
  const response = new RecordingResponse('GET');
  handle({ method: 'GET' }, response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 0);
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).configured, false);
});

test('an unhealthy fetch or shape error answers an explicit failure, not a crash', async () => {
  const { handle } = handlerWithDocument({ type: 'NotAFeatureCollection' });
  const response = new RecordingResponse('GET');
  handle({ method: 'GET' }, response);
  await new Promise((resolve) => setImmediate(resolve));
  const payload = JSON.parse(response.body);
  assert.equal(payload.error, 'not a GeoJSON FeatureCollection');
  assert.deepEqual(payload.rows, []);
});

test('a valid document answers the same row shape the ais-live bridge feeds', async () => {
  const { handle } = handlerWithDocument(
    parsedFeatureCollection({ newestAtMs: Date.now() - 60_000 }),
  );
  const response = new RecordingResponse('GET');
  handle({ method: 'GET' }, response);
  await new Promise((resolve) => setImmediate(resolve));
  const payload = JSON.parse(response.body);
  assert.equal(payload.source, 'Aiscast');
  assert.equal(payload.configured, true);
  assert.equal(payload.status, 'live');
  assert.equal(payload.error, null);
  assert.equal(payload.rows.length, 2);
  assert.equal(payload.rows[0].mmsi, '205431000');
  assert.equal(payload.staleAfterMs, AISCAST_STALE_MS);
  assert.ok(Number.isFinite(payload.generatedAt));
});

test('a fetch transport error answers with the short decode', async () => {
  const { handle } = handlerWithDocument({}, { MS_ERRNO: 'unreachable' });
  const response = new RecordingResponse('GET');
  handle({ method: 'GET' }, response);
  await new Promise((resolve) => setImmediate(resolve));
  const payload = JSON.parse(response.body);
  assert.equal(payload.error, 'unreachable');
  assert.deepEqual(payload.rows, []);
  assert.equal(payload.rawFeatureCount, 0);
});

test('unparseable JSON body answers BAD_JSON without losing its shape', async () => {
  const { handle } = createAiscastHandler({
    urlValue: 'http://127.0.0.1:8080/v1/vessels',
    documentFetcher: async () => 'not json at all',
  });
  const response = new RecordingResponse('GET');
  handle({ method: 'GET' }, response);
  await new Promise((resolve) => setImmediate(resolve));
  const payload = JSON.parse(response.body);
  assert.equal(payload.error, 'unparseable JSON body');
});

test('the handler coalesces concurrent requests behind one upstream fetch', async () => {
  let resolveDocument;
  const documentFetcher = () =>
    new Promise((resolve) => {
      resolveDocument = resolve;
    });
  const { handle } = createAiscastHandler({
    urlValue: 'http://127.0.0.1:8080/v1/vessels',
    documentFetcher,
  });
  const requestA = new RecordingResponse('GET');
  const requestB = new RecordingResponse('GET');
  handle({ method: 'GET' }, requestA);
  handle({ method: 'GET' }, requestB);
  resolveDocument(JSON.stringify({ type: 'FeatureCollection', features: [] }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const first = JSON.parse(requestA.body);
  const second = JSON.parse(requestB.body);
  assert.equal(first.configured, true);
  assert.equal(second.rows.length, 0);
  // Each request shares the same upstream answer, and generatedAt matches.
  assert.equal(first.generatedAt, second.generatedAt);
});

test('the handler caching window prevents an immediate refetch of the same document', async () => {
  let documentCalls = 0;
  const { handle } = createAiscastHandler({
    urlValue: 'http://127.0.0.1:8080/v1/vessels',
    documentFetcher: async () => {
      documentCalls += 1;
      return JSON.stringify(parsedFeatureCollection());
    },
  });
  const first = new RecordingResponse('GET');
  const second = new RecordingResponse('GET');
  handle({ method: 'GET' }, first);
  await new Promise((resolve) => setImmediate(resolve));
  handle({ method: 'GET' }, second);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(first.body).rows.length, 2);
  assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));
  assert.equal(documentCalls, 1);
});

test('non-GET requests on the route are refused without an upstream read', async () => {
  const { handle } = createAiscastHandler({
    urlValue: 'http://127.0.0.1:8080/v1/vessels',
    documentFetcher: async () => {
      throw new Error('must not be called');
    },
  });
  const response = new RecordingResponse('POST');
  handle({ method: 'POST' }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.get('Allow'), 'GET, HEAD');
});

test('the configured URL is fetched with the receiver-tap cap respected', async () => {
  let seen;
  const { handle } = createAiscastHandler({
    urlValue: 'http://127.0.0.1:8080/v1/vessels',
    documentFetcher: async (url, options) => {
      seen = { url, options };
      return JSON.stringify({ type: 'FeatureCollection', features: [] });
    },
  });
  const response = new RecordingResponse('GET');
  handle({ method: 'GET' }, response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(seen.url.startsWith('http://127.0.0.1:8080/'));
  assert.equal(typeof seen.options.lookupImpl, 'function');
});
