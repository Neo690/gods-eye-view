import test from 'node:test';
import assert from 'node:assert/strict';
import { fishingEffortProxy } from '../../server/providers/fishingEffort.js';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (query) => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get('/api/fishing-effort')({ url: query, method: 'GET' }, res);
    return {
      status: res.status,
      headers: res.headers,
      json: res.body === undefined ? undefined : JSON.parse(res.body),
    };
  };
}

// The gateway answers one object per dataset, each holding that dataset's
// rows; the rows are what carry lat/lon/hours.
const ENTRIES = {
  entries: [
    {
      'public-global-fishing-effort:v5.0': [
        { lat: 10, lon: 20, hours: 2, flag: 'ESP', geartype: 'TRAWLERS' },
        { lat: 10, lon: 20, hours: 3, flag: 'FRA', geartype: 'TRAWLERS' },
        { lat: 11, lon: 21, hours: 0.5 },
        { lat: 'x', lon: 22, hours: 4 },
      ],
    },
  ],
};

const reportOk = (payload = ENTRIES) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => payload,
  text: async () => JSON.stringify(payload),
  body: { cancel: async () => {} },
});

test('a deployment without GFW_API_TOKEN answers no_key and asks nothing upstream', async () => {
  let calls = 0;
  const request = install(
    fishingEffortProxy({
      token: () => '',
      fetchImpl: async () => {
        calls++;
        return reportOk();
      },
    }),
  );
  const answer = await request('?west=-1&east=1&south=-1&north=1');
  assert.equal(answer.status, 503);
  assert.equal(answer.json.error, 'no_key');
  assert.equal(calls, 0);
});

test('a report is a polygon, authenticated, aggregated per cell and cached', async () => {
  const seen = [];
  let clock = 1_000_000;
  const request = install(
    fishingEffortProxy({
      token: () => 'gfw-token',
      now: () => clock,
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return reportOk();
      },
    }),
  );
  const first = await request('?west=-10&east=10&south=-5&north=5&days=7');
  assert.equal(first.status, 200);
  assert.equal(first.json.cells.length, 2, 'one row per cell');
  assert.deepEqual(first.json.cells[0], { lat: 10, lon: 20, hours: 5 });
  assert.equal(first.json.totalHours, 5.5);
  assert.equal(first.headers['x-fishing-effort-cache'], 'MISS');

  const call = seen[0];
  const url = new URL(call.url);
  assert.equal(url.origin, 'https://gateway.api.globalfishingwatch.org');
  assert.equal(url.searchParams.get('format'), 'JSON');
  assert.equal(url.searchParams.get('temporal-resolution'), 'ENTIRE');
  // `group-by` is mandatory upstream: without it the gateway answers 422.
  assert.equal(url.searchParams.get('group-by'), 'FLAG');
  // `spatial-aggregation=true` erases the coordinates, so it must not be sent.
  assert.equal(url.searchParams.get('spatial-aggregation'), null);
  assert.equal(url.searchParams.get('datasets[0]'), 'public-global-fishing-effort:latest');
  assert.match(url.searchParams.get('date-range'), /^\d{4}-\d\d-\d\d,\d{4}-\d\d-\d\d$/);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer gfw-token');
  const body = JSON.parse(call.init.body);
  // The payload is a GeoJSON object; the gateway refuses a stringified one
  // with 422 "body malformed".
  assert.equal(typeof body.geojson, 'object');
  const polygon = body.geojson;
  assert.deepEqual(polygon.features[0].geometry.coordinates[0][0], [-10, -5]);

  const again = await request('?west=-10&east=10&south=-5&north=5&days=7');
  assert.equal(again.headers['x-fishing-effort-cache'], 'HIT');
  assert.equal(seen.length, 1, 'a cached view costs no report');
  clock += 5 * 60_000;
  await request('?west=-10&east=10&south=-5&north=5&days=7');
  assert.equal(seen.length, 1);
});

test('a flat report shape still reduces', async () => {
  const request = install(
    fishingEffortProxy({
      token: () => 'gfw-token',
      fetchImpl: async () =>
        reportOk({ entries: [{ lat: 1, lon: 2, hours: 1.5 }] }),
    }),
  );
  const answer = await request('?west=-10&east=10&south=-5&north=5');
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.json.cells, [{ lat: 1, lon: 2, hours: 1.5 }]);
});

test('reports are serialised: one token may run only one report at a time', async () => {
  let active = 0;
  let peak = 0;
  const request = install(
    fishingEffortProxy({
      token: () => 'gfw-token',
      fetchImpl: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return reportOk();
      },
    }),
  );
  const [a, b] = await Promise.all([
    request('?west=-10&east=10&south=-5&north=5'),
    request('?west=-20&east=0&south=-5&north=5'),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(peak, 1);
});

test('an oversized viewport is refused before any report runs', async () => {
  let calls = 0;
  const request = install(
    fishingEffortProxy({
      token: () => 'gfw-token',
      fetchImpl: async () => {
        calls++;
        return reportOk();
      },
    }),
  );
  const answer = await request('?west=-170&east=170&south=-5&north=5');
  assert.equal(answer.status, 400);
  assert.equal(answer.json.error, 'area_too_large');
  assert.equal(calls, 0);
});

test('a failed report serves its last copy, and 502s when there is none', async () => {
  let clock = 1_000_000;
  let fail = false;
  const request = install(
    fishingEffortProxy({
      token: () => 'gfw-token',
      now: () => clock,
      cacheMs: 1,
      fetchImpl: async () => {
        if (fail) throw new Error('offline');
        return reportOk();
      },
    }),
  );
  assert.equal((await request('?west=-10&east=10&south=-5&north=5')).status, 200);
  clock += 60_000;
  fail = true;
  const stale = await request('?west=-10&east=10&south=-5&north=5');
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['x-fishing-effort-cache'], 'STALE-ERROR');
  assert.equal(stale.json.stale, true);

  const cold = await request('?west=-30&east=-20&south=-5&north=5');
  assert.equal(cold.status, 502);
  assert.equal(cold.json.error, 'fishing_effort_unavailable');
});
