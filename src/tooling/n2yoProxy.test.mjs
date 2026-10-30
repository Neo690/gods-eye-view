import test from 'node:test';
import assert from 'node:assert/strict';
import { n2yoProxy } from '../../server/providers/n2yo.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (url) => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get('/api/n2yo/above')({ url, method: 'GET' }, res);
    return {
      status: res.status,
      headers: res.headers,
      json: res.body === undefined ? undefined : JSON.parse(res.body),
    };
  };
}

const ABOVE = Object.freeze({
  info: { satcount: 1 },
  above: [{ satid: 25544, satname: 'ISS', satlat: 1, satlng: 2, alt: 419 }],
});

test('a deployment without N2YO_API_KEY answers no_key and reads no upstream', async () => {
  let calls = 0;
  const request = install(
    n2yoProxy({
      apiKey: () => '',
      fetchImpl: async () => {
        calls++;
        return new Response('{}');
      },
    }),
  );
  const res = await request('/api/n2yo/above?lat=48.85&lon=2.35&radius=70');
  assert.equal(res.status, 503);
  assert.equal(res.json.error, 'no_key');
  assert.equal(calls, 0);
});

test('the route adds the key, clamps the observer cell and caches the answer', async () => {
  const asked = [];
  let clock = 1_000_000;
  const request = install(
    n2yoProxy({
      apiKey: () => 'secret-key',
      now: () => clock,
      fetchImpl: async (url) => {
        asked.push(url);
        return new Response(JSON.stringify(ABOVE), {
          headers: { 'Content-Type': 'application/json' },
        });
      },
    }),
  );
  const first = await request('/api/n2yo/above?lat=120&lon=-200&radius=300');
  assert.equal(first.status, 200);
  assert.equal(first.json.above.length, 1);
  assert.equal(Object.hasOwn(first.json, 'apiKey'), false);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /\/above\/90\.0\/-180\.0\/0\/90\/0\//);
  assert.match(asked[0], /apiKey=secret-key$/);

  clock += 30_000;
  const second = await request('/api/n2yo/above?lat=90&lon=-180&radius=90');
  assert.equal(second.status, 200);
  assert.equal(second.headers['x-n2yo-cache'], 'HIT');
  assert.equal(asked.length, 1, 'a minute of answers costs one upstream call');
});

test('an upstream failure relays the last answer, and 502s when there is none', async () => {
  let clock = 1_000_000;
  let fail = false;
  const request = install(
    n2yoProxy({
      apiKey: () => 'secret-key',
      now: () => clock,
      fetchImpl: async () => {
        if (fail) throw new Error('offline');
        return new Response(JSON.stringify(ABOVE));
      },
    }),
  );
  assert.equal((await request('/api/n2yo/above?lat=0&lon=0')).status, 200);
  clock += 120_000;
  fail = true;
  const stale = await request('/api/n2yo/above?lat=0&lon=0');
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['x-n2yo-cache'], 'STALE-ERROR');
  assert.equal(stale.json.above.length, 1);

  const cold = await request('/api/n2yo/above?lat=10&lon=10');
  assert.equal(cold.status, 502);
  assert.equal(cold.json.error, 'upstream_unavailable');
});
