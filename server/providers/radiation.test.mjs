import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { radiationProxy } from './radiation.js';
import { MAX_STATIONS } from '../../src/layers/radiation/records.js';

const BFS = (count = 2) => ({
  type: 'FeatureCollection',
  features: Array.from({ length: count }, (_, index) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [10 + index / 100, 50] },
    properties: {
      kenn: `bfs-${index}`,
      name: `Station ${index}`,
      value: 0.1 + index / 1000,
      end_measure: '2026-10-24T20:00:00Z',
    },
  })),
});

const CANADA = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-79.06, 43.81] },
      properties: {
        OBJECTID: 5249,
        location_name: '1000_10_43.8173_-79.0614',
        latest_value_nSvHr: 29,
        time: 1792872900000,
      },
    },
  ],
};

const SAFECAST = [
  {
    id: 7,
    value: 334,
    unit: 'cpm',
    latitude: 48.85,
    longitude: 2.35,
    captured_at: '2026-10-24T20:00:00Z',
  },
];

/** radmon.org's combined list: parallel columns, one entry per station. */
const RADMON = [
  ['alpha', 'bravo'],
  ['Rivas-Vaciamadrid', 'Haifa'],
  [],
  [],
  [],
  [],
  [],
  ['20.4', '17'],
  ['0', '0'],
  [0, 1],
  ['40.3783', '32.7936'],
  ['-3.53188', '35.0057'],
  2,
  ['0.0057', '0.0057'],
  1792876968,
];

/** uRADMonitor `GET /api/v1/devices`: the units one account may read. */
const URADMONITOR = [
  {
    id: '82000466',
    status: 1,
    last_cpm: 20,
    factor: 0.01,
    timelast: Math.round(Date.parse('2026-10-24T20:40:00Z') / 1000),
    latitude: 48.85,
    longitude: 2.35,
    city: 'Paris',
    country: 'FR',
  },
];

const PROTONS = [
  { time_tag: '2026-10-24T20:30:00Z', flux: 0.5, energy: '>=10 MeV' },
];
const KP = [{ time_tag: '2026-10-24T20:30:00', kp_index: 2 }];

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Route the six upstreams by URL; unmatched hosts fail loudly. */
function routing(overrides = {}) {
  const calls = [];
  const sent = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    sent.push(init?.headers || {});
    const href = String(url);
    if (href.includes('imis.bfs.de'))
      return overrides.bfs ? overrides.bfs() : json(BFS());
    if (href.includes('maps-cartes.services.geo.ca')) return json(CANADA);
    if (href.includes('api.safecast.org'))
      return overrides.safecast ? overrides.safecast() : json(SAFECAST);
    if (href.includes('radmon.org'))
      return overrides.radmon ? overrides.radmon() : json(RADMON);
    if (href.includes('data.uradmonitor.com'))
      return overrides.uradmonitor
        ? overrides.uradmonitor()
        : json(URADMONITOR);
    if (href.includes('integral-protons')) return json(PROTONS);
    if (href.includes('planetary_k_index')) return json(KP);
    throw new Error(`unexpected upstream ${href}`);
  };
  return { fetchImpl, calls, sent };
}

/** Stand-in for the middleware's (req, res). */
function call(plugin, { url = '/', method = 'GET' } = {}) {
  const res = new EventEmitter();
  res.destroyed = false;
  res.headers = {};
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = { ...headers };
    return res;
  };
  res.end = (body) => {
    res.body = body;
    res.emit('done', body);
  };
  const req = {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
  };
  const done = new Promise((resolve) => res.once('done', resolve));
  return plugin.__handler(req, res).then(async () => {
    await done;
    return {
      status: res.status,
      headers: res.headers,
      body: JSON.parse(res.body),
    };
  });
}

function plugin(options = {}) {
  const created = radiationProxy({
    perMinute: 0,
    // Never inherit the developer's real keys: the snapshot must be
    // reproducible whether or not they are exported in the shell.
    uradmonitorId: null,
    uradmonitorHash: null,
    ...options,
  });
  let handler = null;
  created.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return { ...created, __handler: handler };
}

test('one snapshot carries every keyless network and the space readings', async () => {
  const { fetchImpl, calls } = routing();
  const p = plugin({
    fetchImpl,
    now: () => Date.parse('2026-10-24T21:00:00Z'),
  });
  const answer = await call(p);

  assert.equal(answer.status, 200);
  assert.equal(
    answer.body.stations.length,
    6,
    '2 BfS + 1 Canada + 1 Safecast + 2 radmon',
  );
  const byNetwork = (id) =>
    answer.body.stations.filter((row) => row.network === id);
  assert.equal(byNetwork('bfs').length, 2);
  assert.equal(byNetwork('canada')[0].usvh, 0.029);
  assert.equal(byNetwork('safecast')[0].usvh, 1);
  assert.equal(byNetwork('radmon').length, 2);
  assert.equal(byNetwork('radmon')[0].usvh, 20.4 * 0.0057);
  assert.deepEqual(
    answer.body.sources.map((source) => [source.id, source.ok, source.count]),
    [
      ['bfs', true, 2],
      ['canada', true, 1],
      ['safecast', true, 1],
      ['radmon', true, 2],
    ],
  );
  assert.equal(answer.body.space.kp, 2);
  assert.equal(answer.body.space.band, 'calm');
  assert.equal(calls.length, 6, 'four networks plus two space feeds');
  assert.equal(answer.headers['Cache-Control'], 'no-store');
});

test('uRADMonitor joins the snapshot only when its keys are configured', async () => {
  const now = () => Date.parse('2026-10-24T21:00:00Z');
  const anonymous = routing();
  const withoutKeys = plugin({ fetchImpl: anonymous.fetchImpl, now });
  await call(withoutKeys);
  assert.equal(
    anonymous.calls.some((url) => url.includes('data.uradmonitor.com')),
    false,
    'no keys means no request, not a failed one',
  );

  const keyed = routing();
  const p = plugin({
    fetchImpl: keyed.fetchImpl,
    now,
    uradmonitorId: '11175',
    uradmonitorHash: 'test-hash',
  });
  const answer = await call(p);

  assert.equal(answer.status, 200);
  const unit = answer.body.stations.filter(
    (row) => row.network === 'uradmonitor',
  );
  assert.equal(unit.length, 1);
  assert.equal(unit[0].usvh, 0.2);
  assert.equal(unit[0].name, 'Paris, FR');
  const index = keyed.calls.findIndex((url) =>
    url.includes('data.uradmonitor.com'),
  );
  assert.ok(index >= 0, 'the network is queried once its keys exist');
  assert.equal(keyed.sent[index]['X-User-id'], '11175');
  assert.equal(keyed.sent[index]['X-User-hash'], 'test-hash');
  assert.deepEqual(
    answer.body.sources.map((source) => [source.id, source.ok, source.count]),
    [
      ['bfs', true, 2],
      ['canada', true, 1],
      ['safecast', true, 1],
      ['radmon', true, 2],
      ['uradmonitor', true, 1],
    ],
  );
});

test('a failing network degrades the answer instead of emptying the layer', async () => {
  const { fetchImpl } = routing({
    bfs: () => json({ message: 'pool error' }, 500),
  });
  const p = plugin({
    fetchImpl,
    now: () => Date.parse('2026-10-24T21:00:00Z'),
  });
  const answer = await call(p);

  assert.equal(answer.status, 200);
  assert.equal(answer.body.stations.length, 4, 'the other networks still draw');
  const bfs = answer.body.sources.find((source) => source.id === 'bfs');
  assert.equal(bfs.ok, false);
  assert.equal(bfs.error, 'upstream_unavailable');
  assert.equal(answer.headers['X-Data-Degraded'], 'true');
});

test('the snapshot is reused within its window and refreshed after it', async () => {
  const { fetchImpl, calls } = routing();
  let clock = Date.parse('2026-10-24T21:00:00Z');
  const p = plugin({ fetchImpl, now: () => clock, cacheMs: 60_000 });

  await call(p);
  const afterFirst = calls.length;
  await call(p);
  assert.equal(
    calls.length,
    afterFirst,
    'a second request reads no upstream again',
  );

  clock += 61_000;
  await call(p);
  assert.ok(
    calls.length > afterFirst,
    'once the window passes, the feeds are read again',
  );
});

test('the route answers GET at its own path only', async () => {
  const { fetchImpl } = routing();
  const p = plugin({ fetchImpl });
  assert.equal((await call(p, { method: 'POST' })).status, 405);
  assert.equal((await call(p, { url: '/other' })).status, 404);
});

test('one snapshot never exceeds the station budget', async () => {
  const { fetchImpl } = routing({
    bfs: () => json(BFS(MAX_STATIONS + 50)),
  });
  const p = plugin({
    fetchImpl,
    now: () => Date.parse('2026-10-24T21:00:00Z'),
  });
  const answer = await call(p);
  assert.equal(answer.status, 200);
  assert.ok(answer.body.stations.length <= MAX_STATIONS);
});
