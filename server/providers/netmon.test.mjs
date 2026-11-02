import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mapTargetRow,
  netMonProxy,
  parseNetmonTargets,
  tcpProbe,
} from './netmon.js';

function responder(handler, { method = 'GET', url = '/' } = {}) {
  let status = null;
  let payload = null;
  let headers = null;
  handler(
    { method, url },
    {
      writeHead(code, writeHeaders) {
        status = code;
        headers = writeHeaders;
      },
      end(body) {
        payload = JSON.parse(body);
      },
    },
  );
  // The handler resolves its reads asynchronously; await one macro tick so a
  // direct call never reads the answer before it was written.
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          get status() {
            return status;
          },
          get payload() {
            return payload;
          },
          get headers() {
            return headers;
          },
        }),
      0,
    ),
  );
}

test('parseNetmonTargets reads label|host|port|lat|lon and skips malformed rows', () => {
  assert.deepEqual(parseNetmonTargets(''), []);
  assert.deepEqual(parseNetmonTargets(undefined), []);
  assert.deepEqual(
    parseNetmonTargets('HQ|firewall.example.net|443|40.7128|-74.006'),
    [
      {
        id: 'netmon:firewall.example.net:443',
        label: 'HQ',
        host: 'firewall.example.net',
        port: 443,
        lat: 40.7128,
        lon: -74.006,
      },
    ],
  );
  // A target without a position is still probed; it just cannot be drawn.
  assert.deepEqual(
    parseNetmonTargets('Rack|rack-b.example.net|8080'),
    [
      {
        id: 'netmon:rack-b.example.net:8080',
        label: 'Rack',
        host: 'rack-b.example.net',
        port: 8080,
        lat: null,
        lon: null,
      },
    ],
  );
  assert.deepEqual(
    parseNetmonTargets(';bad;;0;0;;|host only|99|1;Full|a|65536|1|2;Half|b|80|95|200'),
    [
      {
        id: 'netmon:b:80',
        label: 'Half',
        host: 'b',
        port: 80,
        lat: null,
        lon: null,
      },
    ],
  );
});

test('tcpProbe answers the deadline instead of hanging on a refused port', async () => {
  // Port 1 on localhost is refused in seconds; the probe resolves, rejects nothing.
  const result = await tcpProbe('127.0.0.1', 1, { timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.equal(typeof result.latencyMs, 'number');
  assert.ok(result.error);
});

test('a server with no configured targets answers 503 explaining the setup step', async () => {
  const proxy = netMonProxy({ env: '' });
  const read = await responder(proxy.handler);
  assert.equal(read.status, 503);
  assert.equal(read.payload.error, 'netmon_not_configured');
  assert.equal((await responder(proxy.handler, { method: 'POST' })).status, 405);
  assert.equal((await responder(proxy.handler, { url: '/other' })).status, 404);
});

test('the monitor answers probe results as map rows and refreshes past its cache', async () => {
  let round = 0;
  const probes = [
    { ok: true, latencyMs: 12, error: null },
    { ok: false, latencyMs: 5000, error: 'timeout' },
    { ok: true, latencyMs: 5, error: null },
    { ok: false, latencyMs: 20, error: 'ECONNREFUSED' },
  ];
  let clock = 1_000_000;
  const proxy = netMonProxy({
    env: 'HQ|a.example.net|443|40.7|-74.0; Rack|b.example.net|8080',
    probe: async (host, port) => {
      assert.equal(port, host === 'a.example.net' ? 443 : 8080);
      return probes[round++];
    },
    now: () => clock,
  });
  const { handler } = proxy;

  const first = await responder(handler);
  assert.equal(first.status, 200);
  assert.deepEqual(first.payload.points, [
    {
      id: 'netmon:a.example.net:443',
      lat: 40.7,
      lon: -74,
      label: 'HQ',
      meta: {
        status: 'up',
        latencyMs: 12,
        error: null,
        host: 'a.example.net:443',
        checkedAt: 1_000_000,
      },
    },
  ]);
  // One placed row out of two configured: the unplaced node is probed, not drawn.
  assert.equal(first.payload.totalTargets, 2);
  assert.equal(first.payload.placedTargets, 1);
  assert.equal(first.payload.points.length, 1);

  // Inside the cache window the answer is served as-is.
  clock += 1000;
  const cached = await responder(handler);
  assert.equal(cached.payload.ageMs, 1000);
  assert.equal(cached.payload.stale, false);
  assert.equal(round, 2);

  // Past the window the cached answer is served and a fresh round is scheduled;
  // the next caller sees the new round, not a re-probe per request. The
  // refreshed round was probed at the serving clock, not at the later read.
  clock += 60_000;
  const whileRefreshing = await responder(handler);
  assert.equal(whileRefreshing.payload.ageMs, 61_000);
  clock += 1000;
  const afterRefreshing = await responder(handler);
  assert.equal(afterRefreshing.payload.points[0].meta.status, 'up');
  assert.equal(afterRefreshing.payload.points[0].meta.checkedAt, 1_061_000);
});

test('mapTargetRow shapes a placed probe answer and never a guessed location', async () => {
  const target = { id: 'netmon:a:443', label: 'HQ', host: 'a', port: 443, lat: 1, lon: 2 };
  assert.deepEqual(mapTargetRow(target, { ok: false, latencyMs: 3, error: 'timeout', checkedAt: 9 }), {
    id: 'netmon:a:443',
    lat: 1,
    lon: 2,
    label: 'HQ',
    meta: { status: 'down', latencyMs: 3, error: 'timeout', host: 'a:443', checkedAt: 9 },
  });
  const fromNothing = mapTargetRow(target);
  assert.equal(fromNothing?.meta.status, 'unknown', 'an answer is unknown until its probe ran');
  assert.equal(
    mapTargetRow({ ...target, lat: null, lon: null }, { ok: true, latencyMs: 3, error: null }),
    null,
    'an unpositioned target is never drawn from a guessed location',
  );
});
