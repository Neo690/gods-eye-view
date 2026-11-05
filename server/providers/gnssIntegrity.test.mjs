import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { gnssIntegrityProxy } from './gnssIntegrity.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');

/** One qualifying aircraft; the rows themselves are records.js' problem. */
const snapshot = {
  now: Math.round(NOW / 1000),
  ac: [
    {
      hex: 'abc123',
      type: 'adsb_icao',
      version: 2,
      alt_baro: 30000,
      lat: 50.1,
      lon: 30.2,
      nic: 8,
      nac_p: 10,
      seen_pos: 5,
    },
  ],
};

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
  const calls = [];
  const created = gnssIntegrityProxy({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return Response.json(snapshot, {
        headers: { 'x-adsb-time': String(snapshot.now) },
      });
    },
    now: () => NOW,
    monotonicNow: () => 0,
    warn: () => {},
    ...options,
  });
  let handler = null;
  created.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return { ...created, __handler: handler, calls };
}

test('the ordinary view route works and ignores the sweep gate entirely', async () => {
  const p = plugin();
  const answer = await call(p, { url: '/?lat=50&lon=30' });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.rows.length, 1);
  const swept = await call(p, { url: '/?lat=51&lon=30' });
  assert.equal(swept.status, 200);
});

test('a marked sweep request rides the same fixed route when enabled', async () => {
  const p = plugin();
  const answer = await call(p, { url: '/?lat=50&lon=30&sweep=1' });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.rows.length, 1);
});

test('GNSS_SWEEP_ENABLED=0 answers sweeps with 403 but keeps the view route', async () => {
  const p = plugin({ sweepEnabled: false });
  const refused = await call(p, { url: '/?lat=50&lon=30&sweep=1' });
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { error: 'sweep_disabled' });
  assert.ok(!refused.calls, 'no upstream read for a refused sweep');
  const ordinary = await call(p, { url: '/?lat=50&lon=30' });
  assert.equal(ordinary.status, 200, 'the kill switch is sweep-scoped');
});

test('the sweep budget is a separate per-client hourly window', async () => {
  const p = plugin({ sweepMaxPerHour: 2 });
  await call(p, { url: '/?lat=0&lon=0&sweep=1' });
  await call(p, { url: '/?lat=1&lon=0&sweep=1' });
  const third = await call(p, { url: '/?lat=2&lon=0&sweep=1' });
  assert.equal(third.status, 429);
  assert.deepEqual(third.body, { error: 'sweep_budget_exhausted' });
  assert.equal(third.headers['Retry-After'], '300');
  assert.equal(p.calls.length, 2, 'the exhausted request never reaches the feed');
  // The per-minute view route is untouched by the sweep budget.
  const view = await call(p, { url: '/?lat=3&lon=0' });
  assert.equal(view.status, 200);
});
