import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  allowedUpstreamUrls,
  relayTarget,
  upstreamRelayProxy,
} from './upstream.js';
import { TRANSIT_ENABLED_FEEDS } from '../../src/data/transitFeeds.js';

const BRESt = TRANSIT_ENABLED_FEEDS.find((feed) => feed.id === 'bibus-brest');
const TORONTO = TRANSIT_ENABLED_FEEDS.find((feed) => feed.id === 'ttc-toronto');

/** A response object shaped like fetch's, over fixed bytes. */
function response(
  bytes,
  { status = 200, type = 'application/x-protobuf' } = {},
) {
  return new Response(bytes, {
    status,
    headers: { 'content-type': type, 'content-length': String(bytes.length) },
  });
}

/**
 * A stand-in for the middleware's (req, res): collects the status, headers and
 * body the handler wrote.
 */
function call(
  plugin,
  { url, method = 'GET', remoteAddress = '127.0.0.1' } = {},
) {
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
    res.emit('done');
  };
  const req = {
    method,
    url,
    socket: { remoteAddress },
    headers: { host: 'localhost' },
  };
  const handler = plugin.__handler;
  return handler(req, res).then(() => ({
    status: res.status,
    headers: res.headers,
    text: Buffer.isBuffer(res.body)
      ? res.body.toString('utf8')
      : String(res.body ?? ''),
    bytes: res.body,
  }));
}

/** Reach into the plugin the way Vite would, and keep the bound handler. */
function plugin(options = {}) {
  const created = upstreamRelayProxy(options);
  let handler = null;
  created.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return { ...created, __handler: handler };
}

test('the relay fetches exactly the registered transit URL, bytes and all', async () => {
  const frames = Buffer.from([0x0a, 0x04, 0x47, 0x54, 0x46, 0x53]);
  const seen = [];
  const p = plugin({
    fetchImpl: async (url, init) => {
      seen.push({ url, redirect: init.redirect });
      return response(frames);
    },
  });
  const answer = await call(p, {
    url: `/?binary=1&url=${encodeURIComponent(BRESt.url)}&_=123`,
  });
  assert.equal(answer.status, 200);
  assert.deepEqual(seen[0].url, new URL(BRESt.url).href);
  assert.equal(seen[0].redirect, 'error', 'a redirect is never followed');
  assert.equal(answer.headers['Content-Type'], 'application/x-protobuf');
  assert.equal(answer.headers['Cache-Control'], 'no-store');
  assert.deepEqual(
    Buffer.from(answer.bytes),
    frames,
    'protobuf survives intact',
  );
});

test('a URL the registry never published is refused, not fetched', async () => {
  let called = 0;
  const p = plugin({
    fetchImpl: async () => {
      called += 1;
      return response(Buffer.from('{}'));
    },
  });
  const answers = await Promise.all([
    call(p, {
      url: `/?url=${encodeURIComponent('https://example.com/secret')}`,
    }),
    call(p, {
      // A registered host, an unregistered path: the allow-list is exact.
      url: `/?url=${encodeURIComponent(new URL('/admin', BRESt.url).href)}`,
    }),
    call(p, { url: '/' }),
    call(p, { url: '/?url=not-a-url' }),
  ]);
  for (const answer of answers) assert.equal(answer.status, 403);
  assert.equal(called, 0, 'nothing unregistered reaches the network');
});

test('only https on the default port, without credentials, is a target', () => {
  const allowed = new Set(['https://proxy.example.org/resource/a']);
  assert.equal(
    relayTarget('https://proxy.example.org/resource/a', allowed),
    'https://proxy.example.org/resource/a',
  );
  assert.equal(
    relayTarget('https://proxy.example.org:443/resource/a', allowed),
    'https://proxy.example.org/resource/a',
    'the default port normalizes to the same URL',
  );
  for (const raw of [
    'http://proxy.example.org/resource/a',
    'https://user:pass@proxy.example.org/resource/a',
    'https://proxy.example.org:8443/resource/a',
    'https://proxy.example.org/resource/a#frag',
    'https://proxy.example.org/resource/b',
    '',
    null,
    undefined,
    42,
    `https://proxy.example.org/${'a'.repeat(3000)}`,
  ]) {
    assert.equal(relayTarget(raw, allowed), null, String(raw).slice(0, 40));
  }
});

test('every enabled feed in the catalogue is relayable, and nothing else is', () => {
  const allowed = allowedUpstreamUrls();
  assert.equal(allowed.size, TRANSIT_ENABLED_FEEDS.length);
  for (const feed of TRANSIT_ENABLED_FEEDS)
    assert.ok(relayTarget(feed.url, allowed), feed.id);
  assert.equal(
    relayTarget('https://gev-data.onrender.com/api/health', allowed),
    null,
  );
});

test('an oversized body is cut at the cap instead of streamed', async () => {
  const p = plugin({
    maxBytes: 32,
    fetchImpl: async () =>
      new Response(new Uint8Array(64).fill(7), {
        headers: { 'content-type': 'application/x-protobuf' },
      }),
  });
  const answer = await call(p, {
    url: `/?url=${encodeURIComponent(TORONTO.url)}`,
  });
  assert.equal(answer.status, 413);
  assert.match(answer.text, /upstream_too_large/);
});

test('an upstream failure or a redirect never poses as success', async () => {
  const failing = plugin({
    fetchImpl: async () => new Response('nope', { status: 503 }),
  });
  const down = await call(failing, {
    url: `/?url=${encodeURIComponent(BRESt.url)}`,
  });
  assert.equal(down.status, 502);

  const redirecting = plugin({
    fetchImpl: async () => {
      throw new TypeError('unexpected redirect');
    },
  });
  const bounced = await call(redirecting, {
    url: `/?url=${encodeURIComponent(BRESt.url)}`,
  });
  assert.equal(bounced.status, 502);

  const throttled = plugin({
    fetchImpl: async () =>
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '30' },
      }),
  });
  const limited = await call(throttled, {
    url: `/?url=${encodeURIComponent(BRESt.url)}`,
  });
  assert.equal(limited.status, 429, 'the shell backs off on an upstream 429');
});

test('the route answers GET only, and only at its own path', async () => {
  const p = plugin({ fetchImpl: async () => response(Buffer.from('{}')) });
  const post = await call(p, {
    method: 'POST',
    url: `/?url=${encodeURIComponent(BRESt.url)}`,
  });
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET');
  const elsewhere = await call(p, {
    url: `/other?url=${encodeURIComponent(BRESt.url)}`,
  });
  assert.equal(elsewhere.status, 404);
});

test('the relay throttles per caller, so one shell cannot hammer a feed', async () => {
  const p = plugin({
    perMinute: 2,
    fetchImpl: async () =>
      response(Buffer.from('{}'), { type: 'application/json' }),
  });
  const request = () =>
    call(p, { url: `/?url=${encodeURIComponent(BRESt.url)}` });
  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 200);
  const third = await request();
  assert.equal(third.status, 429);
  assert.equal(third.headers['Retry-After'], '60');
});
