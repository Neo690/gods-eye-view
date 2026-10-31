import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { AlprUnavailable } from '../alpr/engine.js';
import { ALPR_CACHE_MS, ALPR_MIN_INTERVAL_MS, alprProxy } from './alpr.js';

/** Capture the middleware the plugin installs on a Vite server. */
function install(options) {
  let handler = null;
  alprProxy(options).configureServer({
    middlewares: {
      use(path, next) {
        assert.equal(path, '/api/alpr');
        handler = next;
      },
    },
  });
  return handler;
}

/** A request carrying a JSON body, as the browser sends one. */
function post(body, { method = 'POST', headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { host: 'localhost:4173', ...headers };
  const res = {
    headersSent: false,
    statusCode: 200,
    headers: {},
    payload: null,
    writeHead(status, values = {}) {
      this.statusCode = status;
      Object.assign(this.headers, values);
      this.headersSent = true;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(text) {
      this.payload = text ? JSON.parse(text) : null;
      this.headersSent = true;
    },
  };
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return { req, res };
}

const CAMERA = {
  ok: true,
  bytes: Buffer.from('frame'),
  contentType: 'image/jpeg',
  camera: { id: 'cam-1', name: 'Rue Test', city: 'Paris', provider: 'demo' },
};

const RESULT = {
  plates: [{ text: 'AB-123-CD', confidence: 0.98, box: {}, boxScore: 0.9 }],
  frame: { width: 640, height: 360 },
  model: { detector: 'yolo', ocr: 'cct', input: 384 },
  ms: { decode: 1, detector: 2, ocr: 3, total: 6 },
};

test('the route answers POST only', async () => {
  const handler = install({ cctv: { readSnapshot: async () => CAMERA } });
  const { req, res } = post(undefined, { method: 'GET' });
  await handler(req, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'POST');
});

test('a body without a camera id is refused', async () => {
  const handler = install({ cctv: { readSnapshot: async () => CAMERA } });
  const { req, res } = post({});
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'camera_id_required');
});

test('an unknown camera is a 404, not an empty result', async () => {
  const handler = install({
    cctv: { readSnapshot: async () => ({ ok: false, reason: 'unknown-camera' }) },
  });
  const { req, res } = post({ cameraId: 'nope' });
  await handler(req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.error, 'unknown-camera');
});

test('a camera with no live frame is a 409', async () => {
  const handler = install({
    cctv: { readSnapshot: async () => ({ ok: false, reason: 'frame-unavailable' }) },
  });
  const { req, res } = post({ cameraId: 'cam-1' });
  await handler(req, res);
  assert.equal(res.statusCode, 409);
});

test('a read answers with the plates and says nothing was kept', async () => {
  const handler = install({
    cctv: { readSnapshot: async () => CAMERA },
    read: async () => RESULT,
    now: () => 1_000,
  });
  const { req, res } = post({ cameraId: 'cam-1' });
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.plates, RESULT.plates);
  assert.equal(res.payload.retention, 'none');
  assert.equal(res.payload.cached, false);
  assert.equal(res.headers['x-alpr-cache'], 'MISS');
});

test('a second read of the same camera inside the window is served from memory', async () => {
  let reads = 0;
  const handler = install({
    cctv: { readSnapshot: async () => CAMERA },
    read: async () => {
      reads += 1;
      return RESULT;
    },
    now: () => 5_000,
  });
  const first = post({ cameraId: 'cam-1' });
  await handler(first.req, first.res);
  const second = post({ cameraId: 'cam-1' });
  await handler(second.req, second.res);
  assert.equal(reads, 1);
  assert.equal(second.res.payload.cached, true);
  assert.equal(second.res.headers['x-alpr-cache'], 'HIT');
});

test('a read just after the window is refused rather than repeated', async () => {
  let clock = 10_000;
  const handler = install({
    cctv: { readSnapshot: async () => CAMERA },
    read: async () => RESULT,
    now: () => clock,
  });
  const first = post({ cameraId: 'cam-1' });
  await handler(first.req, first.res);
  clock += ALPR_CACHE_MS + Math.floor(ALPR_MIN_INTERVAL_MS / 2);
  const second = post({ cameraId: 'cam-1' });
  await handler(second.req, second.res);
  assert.equal(second.res.statusCode, 429);
  assert.equal(second.res.payload.error, 'too_soon');
});

test('missing models are a 503 that says how to install them', async () => {
  const handler = install({
    cctv: { readSnapshot: async () => CAMERA },
    read: async () => {
      throw new AlprUnavailable('models_missing', 'not installed', {
        missing: ['detector'],
      });
    },
    now: () => 0,
  });
  const { req, res } = post({ cameraId: 'cam-1' });
  await handler(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.error, 'models_missing');
  assert.equal(res.payload.install, 'npm run alpr:models');
  assert.deepEqual(res.payload.missing, ['detector']);
});

test('a frame too small to hold a plate is a 422', async () => {
  const handler = install({
    cctv: { readSnapshot: async () => CAMERA },
    read: async () => {
      throw new AlprUnavailable('frame_too_small', 'too small');
    },
    now: () => 0,
  });
  const { req, res } = post({ cameraId: 'cam-1' });
  await handler(req, res);
  assert.equal(res.statusCode, 422);
});

test('an unexpected failure does not echo its message', async () => {
  const handler = install({
    cctv: { readSnapshot: async () => CAMERA },
    read: async () => {
      throw new Error('sharp: /secret/path');
    },
    now: () => 0,
  });
  const { req, res } = post({ cameraId: 'cam-1' });
  await handler(req, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.payload.error, 'read_failed');
  assert.equal(JSON.stringify(res.payload).includes('secret'), false);
});

test('without a CCTV catalogue the route refuses instead of guessing', async () => {
  const handler = install({});
  const { req, res } = post({ cameraId: 'cam-1' });
  await handler(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.error, 'camera_source_unavailable');
});

test('a foreign origin is refused before any read', async () => {
  let reads = 0;
  const handler = install({
    cctv: { readSnapshot: async () => CAMERA },
    read: async () => {
      reads += 1;
      return RESULT;
    },
  });
  const { req, res } = post(
    { cameraId: 'cam-1' },
    { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } },
  );
  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(reads, 0);
});
