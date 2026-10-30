import test from 'node:test';
import assert from 'node:assert/strict';
import { spaceTrackProxy } from '../../server/providers/spacetrack.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (route, url = '/') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get(route)({ url, method: 'GET' }, res);
    return {
      status: res.status,
      headers: res.headers,
      json: res.body === undefined ? undefined : JSON.parse(res.body),
    };
  };
}

const TLE = [
  'ISS (ZARYA)',
  '1 25544U 98067A   24001.50000000  .00016717  00000+0  30777-3 0  9993',
  '2 25544  51.6416  90.5085 0004526  90.7038  51.2835 15.49512600  1234',
].join('\n');

const CDM = [
  {
    CDM_ID: 987654,
    TCA: '2026-01-02 00:00:00',
    SAT_1_ID: 25544,
    SAT_1_NAME: 'ISS (ZARYA)',
    SAT_2_ID: 47311,
    SAT_2_NAME: 'COSMOS 2251 DEB',
    MIN_RNG: 0.083,
    PC: 0.000856,
  },
];

const loginOk = () => ({
  ok: true,
  status: 200,
  headers: {
    get: () => null,
    getSetCookie: () => ['PHPSESSID=session-fixture; Path=/; HttpOnly'],
  },
  body: { cancel: async () => {} },
});

const jsonOk = (payload, cookies = []) => ({
  ok: true,
  status: 200,
  headers: { get: () => null, getSetCookie: () => cookies },
  json: async () => payload,
  text: async () => JSON.stringify(payload),
  body: { cancel: async () => {} },
});

const textOk = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => null, getSetCookie: () => [] },
  text: async () => body,
  body: { cancel: async () => {} },
});

test('credentials absent answers no_key and reads nothing upstream', async () => {
  let calls = 0;
  const request = install(
    spaceTrackProxy({
      credentials: () => ({ identity: '', password: '' }),
      fetchImpl: async () => {
        calls++;
        return loginOk();
      },
    }),
  );
  const answer = await request('/api/spacetrack/gp');
  assert.equal(answer.status, 503);
  assert.equal(answer.json.error, 'no_key');
  assert.equal(calls, 0);
});

test('one login serves both routes, and each keeps its own cache window', async () => {
  const seen = [];
  let clock = 1_000_000;
  const request = install(
    spaceTrackProxy({
      credentials: () => ({ identity: 'user', password: 'pass' }),
      now: () => clock,
      fetchImpl: async (url, init = {}) => {
        seen.push({ url, cookie: init.headers?.Cookie });
        if (url.endsWith('/ajaxauth/login')) return loginOk();
        if (url.includes('/class/gp/')) return textOk(TLE);
        return jsonOk(CDM);
      },
    }),
  );

  const gp = await request('/api/spacetrack/gp');
  assert.equal(gp.status, 200);
  assert.equal(gp.json.entries.length, 1);
  assert.equal(gp.json.entries[0].norad, '25544');
  assert.equal(gp.json.entries[0].name, 'ISS (ZARYA)');
  assert.equal(gp.headers['x-spacetrack-cache'], 'MISS');

  const gpAgain = await request('/api/spacetrack/gp');
  assert.equal(gpAgain.headers['x-spacetrack-cache'], 'HIT');

  const cdm = await request('/api/spacetrack/cdm');
  assert.equal(cdm.status, 200);
  assert.equal(cdm.json.messages.length, 1);
  // Login happened once; the query carries its cookie.
  assert.equal(seen.filter((call) => call.url.endsWith('/ajaxauth/login')).length, 1);
  assert.match(seen.at(-1).cookie, /PHPSESSID=session-fixture/);

  clock += 5 * 60_000;
  const cdmSoon = await request('/api/spacetrack/cdm');
  assert.equal(cdmSoon.headers['x-spacetrack-cache'], 'HIT');
  assert.equal(seen.filter((call) => call.url.includes('/class/cdm_public/')).length, 1);
});

test('a failed refresh serves the last copy, and 502s when there is none', async () => {
  let clock = 1_000_000;
  let fail = false;
  const request = install(
    spaceTrackProxy({
      credentials: () => ({ identity: 'user', password: 'pass' }),
      now: () => clock,
      gpCacheMs: 1,
      fetchImpl: async (url) => {
        if (url.endsWith('/ajaxauth/login')) return loginOk();
        if (fail) throw new Error('offline');
        return textOk(TLE);
      },
    }),
  );
  assert.equal((await request('/api/spacetrack/gp')).status, 200);
  clock += 60_000;
  fail = true;
  const stale = await request('/api/spacetrack/gp');
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['x-spacetrack-cache'], 'STALE-ERROR');
  assert.equal(stale.json.stale, true);

  const cold = await request('/api/spacetrack/cdm');
  assert.equal(cold.status, 502);
  assert.equal(cold.json.error, 'spacetrack_unavailable');
});
