import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHlsFrameReader,
  decodeMpegTsFrame,
  isHlsMediaUrl,
} from './hlsFrame.js';

/** Stand-in segment bodies: identity matters, exact shape does not. */
const SEGMENT_NEWER = Buffer.from('segment-newest');
const SEGMENT_OLDER = Buffer.from('segment-older');
const FFMPEG = '/opt/bin/ffmpeg';

/** A puller that behaves like stream.js, from fixed bodies. */
function fakePuller({ entry = { token: 'session-token' }, bodies = [] } = {}) {
  return {
    entry,
    ensureCalls: [],
    released: [],
    async ensure(cameraId, url, leaseId) {
      this.ensureCalls.push({ cameraId, url, leaseId });
      return this.entry;
    },
    async waitReady() {
      return true;
    },
    getRecentSegments(_cameraId, _token, _leaseId, limit) {
      return [...bodies].slice(0, limit);
    },
    release(cameraId, leaseId) {
      this.released.push({ cameraId, leaseId });
    },
  };
}

/**
 * A child_process.stand-in for the ffmpeg pipe: each call produces the next
 * script's stdout bytes, then one `close` event on the next tick — the same
 * order a real process reaches never later than its own exit.
 */
function fakeSpawn(script = []) {
  const calls = [];
  const spawnProcess = () => {
    const step = script[calls.length] ?? { out: null };
    const child = {
      stdin: { ended: null, end(bytes) { child.fed = bytes; }, on() {} },
      handlers: { data: [], close: [] },
      stdout: { on(_event, handler) { child.handlers.data.push(handler); } },
      stderr: { on() {} },
      killedWith: null,
      kill(signal) { child.killedWith = signal; },
    };
    child.on = (event, handler) => {
      if (event === 'close') child.handlers.close.push(handler);
      return child;
    };
    process.nextTick(() => {
      child.out = step.out ?? Buffer.alloc(0);
      child.exit = step.exit ?? 0;
      for (const handler of child.handlers.data) handler(step.out ?? Buffer.alloc(0));
      for (const handler of child.handlers.close) handler(step.exit ?? 0);
    });
    calls.push(child);
    return child;
  };
  return { calls, spawnProcess };
}

/** Whether a promise has settled without waiting on it forever. */
async function settledWithin(promise, ms = 50) {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, ms));
  return settled;
}

test('the reader is pointed at media playlists only', () => {
  assert.equal(isHlsMediaUrl('https://video.deldot.gov/live/x/playlist.m3u8'), true);
  assert.equal(isHlsMediaUrl('https://video.deldot.gov/live/x/playlist.m3u8?v=1'), true);
  // Not a playlist: a still, a bare host, a non-web scheme, or nothing at all.
  for (const value of [
    'https://x.example/a.jpg',
    'https://x.example/',
    'ftp://x.example/a.m3u8',
    '',
    null,
  ])
    assert.equal(isHlsMediaUrl(value), false);
});

test('one read: the newest segment is fed, its JPEG is answered, the lease is freed', async () => {
  const jpeg = Buffer.from('jpeg-bytes');
  const { calls, spawnProcess } = fakeSpawn([{ out: jpeg, exit: 0 }]);
  const puller = fakePuller({ bodies: [SEGMENT_NEWER, SEGMENT_OLDER] });
  const reader = createHlsFrameReader({
    puller,
    resolveFfmpeg: async () => FFMPEG,
    spawnProcess,
  });
  const frame = await reader.read({
    cameraId: 'deldot-ncam205',
    url: 'https://video.deldot.gov/live/NCAM205.stream/playlist.m3u8',
  });
  assert.deepEqual(frame, jpeg);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].out, jpeg);
  // And the fed bytes: exactly the camera's newest buffered segment.
  assert.deepEqual(calls[0].fed, SEGMENT_NEWER);
  assert.deepEqual(puller.released, [
    { cameraId: 'deldot-ncam205', leaseId: 'alpr' },
  ]);
});

test('the newest segment decodes empty: the previous one is tried, the loop is bounded', async () => {
  const jpeg = Buffer.from('jpeg-from-older');
  const { calls, spawnProcess } = fakeSpawn([
    { out: Buffer.alloc(0), exit: 0 },
    { out: jpeg, exit: 0 },
  ]);
  const reader = createHlsFrameReader({
    puller: fakePuller({ bodies: [SEGMENT_NEWER, SEGMENT_OLDER] }),
    resolveFfmpeg: async () => FFMPEG,
    spawnProcess,
  });
  const frame = await reader.read({
    cameraId: 'deldot-ncam205',
    url: 'https://video.deldot.gov/live/NCAM205.stream/playlist.m3u8',
  });
  assert.deepEqual(frame, jpeg);
  // Two attempts, never more; no segment is invented beyond what is buffered.
  assert.equal(calls.length, 2);
});

test('without ffmpeg the read answers nothing, spawns nothing, says it once', async (t) => {
  const lines = [];
  t.mock.method(console, 'warn', (...args) => lines.push(args.join(' ')));
  const { calls, spawnProcess } = fakeSpawn();
  const reader = createHlsFrameReader({
    puller: fakePuller({ bodies: [SEGMENT_NEWER] }),
    resolveFfmpeg: async () => null,
    spawnProcess,
  });
  const read = () =>
    reader.read({
      cameraId: 'deldot-ncam205',
      url: 'https://video.deldot.gov/live/NCAM205.stream/playlist.m3u8',
    });
  assert.equal(await read(), null);
  assert.equal(calls.length, 0);
  assert.equal(lines.filter((line) => /ffmpeg-static/.test(line)).length, 1);
  // The second read stays silent: the reason was already said.
  assert.equal(await read(), null);
  assert.equal(lines.filter((line) => /ffmpeg-static/.test(line)).length, 1);
});

test('a puller failure and an empty session answer nothing and still free the lease', async () => {
  let released = 0;
  const reader = createHlsFrameReader({
    puller: {
      async ensure() {
        throw new Error('HLS upstream refused');
      },
      async waitReady() {
        return false;
      },
      getRecentSegments: () => [],
      release() {
        released += 1;
      },
    },
    resolveFfmpeg: async () => FFMPEG,
  });
  assert.equal(
    await reader.read({
      cameraId: 'deldot-ncam205',
      url: 'https://video.deldot.gov/live/NCAM205.stream/playlist.m3u8',
    }),
    null,
  );
  assert.equal(released, 1);
});

test('guards refuse before the puller is even asked', async () => {
  let ensured = false;
  const reader = createHlsFrameReader({
    puller: {
      async ensure() {
        ensured = true;
        return { token: 't' };
      },
      async waitReady() {
        return true;
      },
      getRecentSegments: () => [SEGMENT_NEWER],
      release() {},
    },
    resolveFfmpeg: async () => FFMPEG,
  });
  // Not a media playlist, no camera id, and a camera id that is not a string.
  assert.equal(await reader.read({ cameraId: 'x', url: 'https://a.example/f.jpg' }), null);
  assert.equal(await reader.read({ cameraId: 'x', url: '' }), null);
  assert.equal(await reader.read({ cameraId: '' }), null);
  assert.equal(await reader.read({}), null);
  assert.equal(ensured, false);
});

test('a decoder that never finishes runs out its deadline and frees the lease', async () => {
  const children = [];
  const reader = createHlsFrameReader({
    puller: fakePuller({ bodies: [SEGMENT_NEWER, SEGMENT_OLDER] }),
    resolveFfmpeg: async () => FFMPEG,
    decodeTimeoutMs: 40,
    spawnProcess() {
      const child = {
        stdin: { end() {}, on() {} },
        stdout: { on() {} },
        stderr: { on() {} },
        handlers: {},
        on(event, handler) {
          child.handlers[event] ||= [];
          child.handlers[event].push(handler);
        },
        kill(signal) {
          child.killedWith ||= signal;
        },
      };
      children.push(child);
      return child;
    },
  });
  const frame = await reader.read({
    cameraId: 'deldot-ncam205',
    url: 'https://video.deldot.gov/live/NCAM205.stream/playlist.m3u8',
  });
  assert.equal(frame, null);
  // Both attempts ran out: nothing was ever answered, no child stayed unbound.
  assert.equal(children.length, 2);
  assert.ok(children.every((child) => child.killedWith === 'SIGKILL'));
});
