import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COPERNICUS_EMS_CACHE_MS,
  COPERNICUS_EMS_ROUTE,
  copernicusEmsFailure,
  copernicusEmsProxy,
  createCopernicusEmsHandler,
} from './copernicusEms.js';

function handlerHarness({ upstream, status = 200, fail = false, ...options } = {}) {
  const responses = [];
  const handler = createCopernicusEmsHandler({
    logger: { warn() {} },
    ...options,
    fetchImpl: async (url) => {
      responses.push({ url });
      if (fail) throw new TypeError('network down');
      return {
        ok: status === 200,
        status,
        text: async () => JSON.stringify(upstream),
      };
    },
  });
  const request = async (method = 'GET') => {
    const record = { statusCode: null, headers: {}, body: '' };
    await handler.handle(
      { method },
      {
        set statusCode(value) {
          record.statusCode = value;
        },
        setHeader(name, value) {
          record.headers[name] = value;
        },
        end(body) {
          record.body = body ?? '';
        },
      },
    );
    return { ...record, json: record.body ? JSON.parse(record.body) : null };
  };
  return { handler, request, responses };
}

const upstreamOk = () => ({
  count: 1,
  results: [
    {
      code: 'EMSR935',
      centroid: 'POINT (0.5 38.5)',
      activationTime: '2026-10-19T16:03:00',
    },
  ],
});

test('the happy path answers an ok payload with the activations page', async () => {
  const { request, responses } = handlerHarness({ upstream: upstreamOk() });
  const answer = await request();
  assert.equal(answer.statusCode, 200);
  assert.equal(answer.headers['content-type'], 'application/json');
  assert.equal(answer.json.ok, true);
  assert.deepEqual(answer.json.activations, upstreamOk().results);
  assert.match(responses[0].url, /limit=200/);
});

test('a HEAD is answered without a body and other verbs are 405', async () => {
  const head = await handlerHarness({ upstream: upstreamOk() }).request('HEAD');
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  const post = await handlerHarness({ upstream: upstreamOk() }).request('POST');
  assert.equal(post.statusCode, 405);
});

test('upstream failures answer ok:false with a text-free short error', async () => {
  const down = await handlerHarness({ fail: true }).request();
  assert.equal(down.json.ok, false);
  assert.equal(down.json.error, 'upstream');
  assert.deepEqual(down.json.activations, []);

  const http = await handlerHarness({ status: 503 }).request();
  assert.equal(http.json.ok, false);
  assert.equal(http.json.error, 'upstream 503');
});

test('unparseable and shape-invalid bodies never leak upstream text', async () => {
  const junk = createCopernicusEmsHandler({
    logger: { warn() {} },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>leak</html>',
    }),
  });
  const record = { statusCode: null, headers: {}, body: '' };
  await junk.handle(
    { method: 'GET' },
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
  assert.equal(json.ok, false);
  assert.equal(json.error, 'unparseable');
  assert.ok(!record.body.includes('leak'));
});

test('a successful answer is cached for the cache interval; failures are not', async () => {
  let calls = 0;
  const handler = createCopernicusEmsHandler({
    logger: { warn() {} },
    fetchImpl: async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(upstreamOk()),
      };
    },
  });
  const call = () =>
    new Promise((resolve) => {
      handler.handle(
        { method: 'GET' },
        {
          set statusCode(value) {},
          setHeader() {},
          end(body) {
            resolve(JSON.parse(body));
          },
        },
      );
    });
  const first = await call();
  const second = await call();
  assert.equal(calls, 1, 'both reads share the cached payload');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(COPERNICUS_EMS_CACHE_MS, 10 * 60 * 1000);
  const failing = createCopernicusEmsHandler({
    logger: { warn() {} },
    fetchImpl: async () => {
      calls++;
      throw new TypeError('down');
    },
  });
  const read = () =>
    new Promise((resolve) => {
      failing.handle(
        { method: 'GET' },
        {
          set statusCode(value) {},
          setHeader() {},
          end(body) {
            resolve(JSON.parse(body));
          },
        },
      );
    });
  const firstFailure = await read();
  const secondFailure = await read();
  assert.equal(firstFailure.ok, false);
  assert.equal(secondFailure.ok, false, 'failures are decoded, not cached');
  assert.equal(calls, 3);
});

test('the proxy mounts the route in dev and preview servers', () => {
  const mounted = [];
  const plugin = copernicusEmsProxy();
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
    ['configureServer', COPERNICUS_EMS_ROUTE, true],
    ['configurePreviewServer', COPERNICUS_EMS_ROUTE, true],
  ]);
});

test('failure payloads are pure helpers with the short codes', () => {
  assert.deepEqual(copernicusEmsFailure('body-too-large'), {
    ok: false,
    error: 'body-too-large',
    activations: [],
    generatedAt: copernicusEmsFailure('body-too-large').generatedAt,
  });
});
