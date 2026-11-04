import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VALYU_EVENTS_ROUTE,
  createValyuEventsHandler,
  valyuEventsProxy,
  valyuFailure,
} from './valyu.js';

function handlerHarness({
  key = 'vt-key',
  upstream,
  status = 200,
  fail = false,
  limiterAllow = () => true,
  ...options
} = {}) {
  const requests = [];
  const handler = createValyuEventsHandler({
    logger: { warn() {} },
    rateLimiter: () => limiterAllow,
    apiKey: key,
    ...options,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (fail) throw new TypeError('network down');
      return {
        ok: status === 200,
        status,
        text: async () => JSON.stringify(upstream),
      };
    },
  });
  const request = async (method = 'GET', url = '/?query=gaza') => {
    const record = { statusCode: null, headers: {}, body: '' };
    await handler.handle(
      { method, url, socket: { remoteAddress: '127.0.0.1' } },
      {
        set statusCode(value) {
          record.statusCode = value;
        },
        setHeader(name, value) {
          record.headers[name.toLowerCase()] = value;
        },
        end(body) {
          record.body = body ?? '';
        },
      },
    );
    return { ...record, json: record.body ? JSON.parse(record.body) : null };
  };
  return { handler, request, requests };
}

const upstreamOk = () => ({
  success: true,
  results: [
    {
      title: 'Strike reported near border',
      url: 'https://example.org/1',
      source: 'Reuters',
      content: 'Summary one.',
      publication_date: '2026-11-03T08:00:00Z',
    },
    { title: 'no url dropped', source: '' },
    { url: 'https://example.org/2', title: 'Held without sources' },
  ],
});

test('a missing key answers a keyless 503 before any upstream call', async () => {
  const { request, requests } = handlerHarness({ key: null });
  const answer = await request();
  assert.equal(answer.statusCode, 503);
  assert.equal(answer.json.ok, false);
  assert.equal(answer.json.error, 'not-configured');
  assert.deepEqual(answer.json.events, []);
  assert.equal(requests.length, 0);
});

test('an over-cap IP is throttled with 429 without spending credits', async () => {
  const { request, requests } = handlerHarness({ limiterAllow: () => false });
  const answer = await request();
  assert.equal(answer.statusCode, 429);
  assert.equal(answer.headers['retry-after'], '5');
  assert.equal(requests.length, 0);
});

test('a missing query is a 400, not an upstream call', async () => {
  const { request, requests } = handlerHarness();
  const answer = await request('GET', '/');
  assert.equal(answer.statusCode, 400);
  assert.equal(requests.length, 0);
});

test('the happy path relays a bounded news search through POST', async () => {
  const { request, requests } = handlerHarness({ upstream: upstreamOk() });
  const answer = await request('GET', '/?query=gaza&maxNumResults=6');
  assert.equal(answer.statusCode, 200);
  assert.equal(
    answer.headers['content-type'],
    'application/json; charset=utf-8',
  );
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.equal(answer.json.ok, true);
  assert.equal(answer.json.events.length, 2, 'shape-invalid rows are dropped');
  assert.equal(answer.json.events[0].title, 'Strike reported near border');
  assert.equal(answer.json.events[0].source, 'Reuters');
  assert.equal(
    answer.json.events[0].publicationDate,
    '2026-11-03T08:00:00.000Z',
  );

  const [call] = requests;
  assert.equal(call.url, 'https://api.valyu.ai/v1/search');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers['x-api-key'], 'vt-key');
  const body = JSON.parse(call.init.body);
  assert.equal(body.query, 'gaza');
  assert.equal(body.max_num_results, 6);
  assert.equal(body.search_type, 'news');
  assert.equal(body.is_tool_call, true);
  assert.equal(body.start_date, undefined);
  assert.equal(typeof call.init.signal, 'object');
});

test('maxNumResults is clamped into the 1..10 band and start_date passes through', async () => {
  const low = handlerHarness({ upstream: upstreamOk() });
  await low.request('GET', '/?query=q&maxNumResults=99');
  const high = handlerHarness({ upstream: upstreamOk() });
  await high.request('GET', '/?query=q&maxNumResults=0&startDate=2026-11-01');
  const bodies = [...low.requests, ...high.requests].map(({ init }) =>
    JSON.parse(init.body),
  );
  assert.equal(bodies[0].max_num_results, 10);
  assert.equal(bodies[1].max_num_results, 1);
  assert.equal(bodies[1].start_date, '2026-11-01');
});

test('upstream failures answer ok:false with short, text-free codes', async () => {
  const down = await handlerHarness({ fail: true }).request();
  assert.equal(down.json.ok, false);
  assert.equal(down.json.error, 'upstream');

  const denied = await handlerHarness({ status: 401 }).request();
  assert.equal(denied.json.error, 'auth');

  const insolvent = await handlerHarness({ status: 402 }).request();
  assert.equal(insolvent.json.error, 'credits');

  const http = await handlerHarness({ status: 500 }).request();
  assert.equal(http.json.error, 'upstream 500');

  const junk = createValyuEventsHandler({
    logger: { warn() {} },
    rateLimiter: () => () => true,
    apiKey: 'vt-key',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>leak</html>',
    }),
  });
  const record = { statusCode: null, body: '' };
  await junk.handle(
    { method: 'GET', url: '/?query=q' },
    {
      set statusCode(value) {
        record.statusCode = value;
      },
      setHeader() {},
      end(body) {
        record.body = body ?? '';
      },
    },
  );
  const json = JSON.parse(record.body);
  assert.equal(json.error, 'unparseable');
  assert.ok(!record.body.includes('leak'));
});

test('a HEAD is answered without a body and other verbs are 405', async () => {
  const head = await handlerHarness({ upstream: upstreamOk() }).request('HEAD');
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.notEqual(head.headers['content-type'], undefined);

  const post = await handlerHarness({ upstream: upstreamOk() }).request('POST');
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('the proxy mounts the gated route in dev and preview servers', () => {
  const mounted = [];
  const plugin = valyuEventsProxy();
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    plugin[hook]({
      middlewares: {
        use(route, handler) {
          mounted.push([hook, route, typeof handler === 'function']);
        },
      },
    });
  }
  assert.deepEqual(mounted, [
    ['configureServer', VALYU_EVENTS_ROUTE, true],
    ['configurePreviewServer', VALYU_EVENTS_ROUTE, true],
  ]);
});

test('failure payloads are pure helpers with empty rows', () => {
  assert.deepEqual(valyuFailure('not-configured'), {
    ok: false,
    error: 'not-configured',
    events: [],
    generatedAt: valyuFailure('not-configured').generatedAt,
  });
});
