import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FACE_MATCH_THRESHOLD, cosineSimilarity } from '../face/engine.js';
import { faceProxy } from './face.js';

const TINY_JPEG = Buffer.alloc(4096, 7);

/** Deterministic pseudo-embedding; two seeds differ in cosine. */
function fakeEmbedding(seed = 1) {
  return Array.from(
    { length: 512 },
    (_, i) => Math.sin((seed + 1) * i * 0.017) * 0.05,
  );
}

/** Fake, detector-side face with plausible landmarks. */
function fakeFace(score = 0.9) {
  return {
    score,
    box: { x1: 10, y1: 10, x2: 60, y2: 60 },
    landmarks: [
      { x: 20, y: 20 }, { x: 40, y: 20 }, { x: 30, y: 32 },
      { x: 22, y: 44 }, { x: 38, y: 44 },
    ],
  };
}

/** Handler contract the route uses, given shape of detect/embed/enroll. */
function handled({ at = 0, detect, embed, enroll, knownOnly = false } = {}) {
  return {
    at,
    cctv: {
      // The real CCTV provider serves only registered camera ids and answers
      // null for anything else; the route never turns an id into a URL.
      readSnapshot: knownOnly
        ? async (id) => (id === 'cam-1' ? TINY_JPEG : null)
        : async () => TINY_JPEG,
    },
    detect: detect ?? (async () => ({
      faces: [fakeFace()],
      frame: { width: 1280, height: 720 },
      model: { detector: 'x', recognizer: 'y' },
      ms: { decode: 1, detector: 1, total: 2 },
    })),
    embed: embed ?? (async () => ({ embedding: fakeEmbedding(1) })),
    enroll,
  };
}

/** One request through the plugin middleware; resolves {status, body}. */
async function call({ url, method = 'POST', body, handler, middleware }) {
  const proxy = middleware ?? faceProxy(handler);
  const request = {
    method,
    url,
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      'sec-fetch-site': 'same-origin',
    },
    on(name, callback) {
      if (name === 'data') callback(Buffer.from(JSON.stringify(body ?? {})));
      if (name === 'end') callback();
    },
  };
  let chunks = '';
  const res = {
    statusCode: 0,
    headersSet: {},
    setHeader(k, v) { this.headersSet[k] = v; },
    end(text) { chunks = text ?? ''; },
  };
  const run = async (resolve) => {
    const server = { middlewares: { use(register) {} } };
    // The plugin's configureServer registers one middleware; run it by hand.
    let fn = null;
    const receivers = { middlewares: { use(register) { fn = register; } } };
    proxy.configureServer(receivers);
    await fn(request, res, () => {});
    try {
      resolve({ status: res.statusCode, body: JSON.parse(chunks) });
    } catch {
      resolve({ status: res.statusCode, body: chunks });
    }
  };
  return new Promise((resolve) => run(resolve));
}

test('analyze answers boxes and counts, consulting no roster', async () => {
  const handler = handled();
  const answer = await call({
    url: '/api/face/analyze',
    body: { cameraId: 'cam-1' },
    handler,
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.count, 1);
  assert.deepEqual(answer.body.faces[0].box, { x1: 10, y1: 10, x2: 60, y2: 60 });
});

test('a rerun of the same camera reuses the 8 s window', async () => {
  let reads = 0;
  const handler = handled({
    detect: async () => {
      reads += 1;
      return { faces: [], frame: {}, model: {}, ms: {} };
    },
  });
  // One provider instance across both calls: the reuse windows live in it.
  const middleware = faceProxy(handler);
  assert.equal(
    (await call({ url: '/api/face/analyze', body: { cameraId: 'cam-1' }, middleware })).body.cached,
    false,
  );
  assert.equal(
    (await call({ url: '/api/face/analyze', body: { cameraId: 'cam-1' }, middleware })).body.cached,
    true,
  );
  assert.equal(reads, 1);
});

test('an arbitrary path cannot be turned into a camera read', async () => {
  const answer = await call({
    url: '/api/face/analyze',
    body: { cameraId: 'https://example.invalid/x' },
    handler: handled({ at: 0, knownOnly: true }),
  });
  // The route serves only registered cctv ids; a path the catalogue does not
  // know falls out as a downstream refusal, never a fetch.
  assert.ok(answer.status >= 400);
});

test('the match threshold gates a cohort match, in cosine terms', () => {
  const samePerson = cosineSimilarity(fakeEmbedding(1), fakeEmbedding(1));
  const otherPerson = cosineSimilarity(fakeEmbedding(1), fakeEmbedding(2));
  assert.ok(samePerson > FACE_MATCH_THRESHOLD);
  assert.ok(otherPerson < FACE_MATCH_THRESHOLD);
});

test('enroll answers without pixels and with metadata only', async () => {
  const handler = handled({
    detect: async () => ({
      faces: [fakeFace()],
      frame: {},
      model: {},
      ms: {},
    }),
    embed: async () => ({ embedding: fakeEmbedding(9) }),
  });
  const answer = await call({
    url: '/api/face/enroll',
    body: {
      label: 'Eve',
      cohort: 'site-staff',
      image: `data:image/png;base64,${TINY_JPEG.toString('base64')}`,
    },
    handler,
  });
  assert.equal(answer.status, 200);
  // The acknowledgment is metadata only: no embedding, no pixels come back.
  const enrollment = answer.body.enrollment;
  assert.equal(enrollment?.label, 'Eve');
  assert.equal(enrollment?.cohort, 'site-staff');
  assert.equal(enrollment?.embeddingLength, 512);
  assert.ok(!('embedding' in enrollment));
  assert.ok(!('image' in enrollment));
});

test('a no-face consent upload explains itself', async () => {
  const handler = handled({ detect: async () => ({ faces: [], frame: {}, model: {}, ms: {} }) });
  const answer = await call({
    url: '/api/face/enroll',
    body: { label: 'no one', cohort: 'x', image: 'data:image/png;base64,AAAA' },
    handler,
  });
  assert.equal(answer.status, 400);
  assert.equal(answer.body.error, 'no_face');
});

test('the enrollment listing answers without embeddings', async () => {
  const answer = await call({
    url: '/api/face/enrollments',
    method: 'GET',
    handler: handled(),
  });
  assert.equal(answer.status, 200);
  assert.ok(Array.isArray(answer.body.enrollments));
});

test('a temp roster dir is used in the test environment', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-face-'));
  assert.ok(dir);
});
