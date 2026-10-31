import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDataUsageMeter,
  formatBytes,
  installFetchByteTap,
  rateFromSamples,
  transferBytes,
} from './dataUsageMeter.js';

test('transferBytes prefers what crossed the wire and ignores withheld sizes', () => {
  assert.equal(
    transferBytes({ transferSize: 1200, encodedBodySize: 3400 }),
    1200,
  );
  assert.equal(transferBytes({ transferSize: 0, encodedBodySize: 3400 }), 3400);
  assert.equal(
    transferBytes({
      transferSize: 0,
      encodedBodySize: 0,
      decodedBodySize: 900,
    }),
    900,
  );
  // A cache hit or a cross-origin response without Timing-Allow-Origin: the
  // browser denies the byte count, so it contributes nothing rather than a lie.
  assert.equal(transferBytes({ transferSize: 0, encodedBodySize: 0 }), 0);
  assert.equal(transferBytes(null), 0);
  assert.equal(transferBytes({ transferSize: 'nope' }), 0);
});

test('formatBytes reads like a network report', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1000), '1 kB');
  assert.equal(formatBytes(1500), '1.5 kB');
  assert.equal(formatBytes(12_400), '12.4 kB');
  assert.equal(formatBytes(84_200_000), '84.2 MB');
  assert.equal(formatBytes(1_240_000_000), '1.2 GB');
  assert.equal(formatBytes(120_000_000), '120 MB');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(Number.NaN), '0 B');
});

test('rateFromSamples divides by the window it actually covers', () => {
  assert.equal(rateFromSamples([], 10_000), 0);
  // 120 kB over the full three-second window is 40 kB/s.
  const full = [
    { at: 7000, bytes: 60_000 },
    { at: 8000, bytes: 30_000 },
    { at: 9000, bytes: 30_000 },
  ];
  assert.equal(rateFromSamples(full, 10_000), 40_000);
  // One fresh second still reads as a rate, not as a third of one.
  assert.equal(rateFromSamples([{ at: 10_000, bytes: 8000 }], 10_000), 8000);
  // Older samples fall out of the window.
  assert.equal(
    rateFromSamples(
      [
        { at: 1000, bytes: 1_000_000 },
        { at: 9000, bytes: 3000 },
      ],
      10_000,
    ),
    3000,
  );
});

/** The smallest document the meter touches, enough to drive its DOM contract. */
function fakeDocument() {
  const listeners = new Map();
  const make = (tagName) => {
    const node = {
      tagName,
      children: [],
      attributes: {},
      classList: {
        values: new Set(),
        toggle(name) {
          if (this.values.has(name)) {
            this.values.delete(name);
            return false;
          }
          this.values.add(name);
          return true;
        },
        contains(name) {
          return this.values.has(name);
        },
      },
      hidden: false,
      textContent: '',
      title: '',
      append(...children) {
        this.children.push(...children);
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      addEventListener(type, handler) {
        listeners.set(`${this.tagName}:${type}`, handler);
      },
      removeEventListener(type) {
        listeners.delete(`${this.tagName}:${type}`);
      },
      remove() {
        this.removed = true;
      },
    };
    return node;
  };

  const titleBar = make('div');
  const actionRow = make('nav');
  const voiceControl = make('div');
  const hudData = make('div');
  const byId = new Map([
    ['title-bar', titleBar],
    ['top-center-actions', actionRow],
    ['gev-voice-control', voiceControl],
    ['hud-data-usage', hudData],
  ]);
  return {
    hidden: false,
    titleBar,
    actionRow,
    voiceControl,
    hudData,
    make,
    byId,
    listeners,
    createElement: (tagName) => make(tagName),
    getElementById: (id) => byId.get(id) ?? null,
    addEventListener(type, handler) {
      listeners.set(`document:${type}`, handler);
    },
    removeEventListener(type) {
      listeners.delete(`document:${type}`);
    },
  };
}

function fakePerformance(entries) {
  return {
    now: () => 5000,
    getEntriesByType: (type) => (type === 'resource' ? entries : []),
  };
}

test('the readout sits in the HUD telemetry window and reports bytes already transferred', () => {
  const documentRef = fakeDocument();
  const entries = [
    {
      name: '/assets/app.js',
      startTime: 10,
      initiatorType: 'script',
      transferSize: 4000,
    },
    {
      name: '/assets/boot.css',
      startTime: 11,
      initiatorType: 'link',
      transferSize: 2000,
    },
  ];
  const meter = createDataUsageMeter({
    documentRef,
    performanceRef: fakePerformance(entries),
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });

  const readout = documentRef.hudData.children.at(-1);
  assert.equal(readout.id, 'data-usage');
  // The window that holds the coordinates holds the traffic too; the mic pill
  // and the application chrome stay empty.
  assert.deepEqual(documentRef.voiceControl.children, []);
  assert.deepEqual(documentRef.actionRow.children, []);
  assert.deepEqual(documentRef.titleBar.children, []);
  // Label, rate, separator, total — and no symbols the reader has to decode.
  assert.equal(readout.children.length, 4);
  assert.equal(readout.children[0].textContent, 'DATA:');
  assert.match(readout.children[1].textContent, /^0 B\/s$/);
  assert.equal(readout.children[2].textContent, '·');
  assert.match(readout.children[3].textContent, /^6 kB$/);

  meter.destroy();
  assert.equal(readout.removed, true);
});

test('a shell without the telemetry window keeps the line above the mic', () => {
  const documentRef = fakeDocument();
  documentRef.byId.delete('hud-data-usage');
  const meter = createDataUsageMeter({
    documentRef,
    performanceRef: fakePerformance([]),
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });

  const readout = documentRef.voiceControl.children.at(-1);
  assert.equal(readout.id, 'data-usage');
  meter.destroy();
});

test('without a timeline there is nothing to measure', () => {
  const meter = createDataUsageMeter({
    documentRef: { getElementById: () => null },
    performanceRef: fakePerformance([]),
  });
  assert.equal(typeof meter.destroy, 'function');
  meter.destroy();
});

test('a HUD built after the meter still gets the line', () => {
  // The HUD renders after the shell's UI init: the meter must wait for its
  // host instead of giving up, and adopt a rebuilt one rather than keep a
  // line that no longer exists on screen.
  const documentRef = fakeDocument();
  const late = documentRef.hudData;
  documentRef.byId.delete('hud-data-usage');

  let tick = null;
  const meter = createDataUsageMeter({
    documentRef,
    performanceRef: fakePerformance([]),
    setIntervalFn: (fn) => {
      tick = fn;
      return 1;
    },
    clearIntervalFn: () => {},
  });
  assert.deepEqual(documentRef.hudData.children, []);

  documentRef.byId.set('hud-data-usage', late);
  tick();
  assert.equal(documentRef.hudData.children.length, 1);
  assert.equal(documentRef.hudData.children[0].id, 'data-usage');

  // A rebuilt window is adopted again rather than left with a dead line.
  const rebuilt = documentRef.make('div');
  documentRef.byId.set('hud-data-usage', rebuilt);
  tick();
  assert.equal(rebuilt.children.length, 1);

  meter.destroy();
});

test('the fetch tap counts a declared length without touching the response', async () => {
  const counted = [];
  const target = {
    fetch: async () =>
      new Response('x'.repeat(50), {
        headers: { 'content-length': '4096' },
      }),
  };
  const tap = installFetchByteTap({
    target,
    onBytes: (bytes) => counted.push(bytes),
  });
  const response = await target.fetch('/api/feed');
  assert.equal(await response.text(), 'x'.repeat(50), 'the body is unchanged');
  assert.deepEqual(counted, [4096]);

  tap.restore();
  assert.equal(typeof target.fetch, 'function');
  assert.deepEqual(counted, [4096], 'a restored tap stops counting');
});

test('the fetch tap counts a streamed body and never keeps it', async () => {
  const counted = [];
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(700));
      controller.enqueue(new Uint8Array(300));
      controller.close();
    },
  });
  const target = { fetch: async () => new Response(body) };
  const tap = installFetchByteTap({
    target,
    onBytes: (bytes) => counted.push(bytes),
  });

  // Read the real response before the counting clone drains it.
  const response = await target.fetch('/api/feed');
  await response.arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(counted, [1000]);
  tap.restore();
});

test('a tapped fetch is not counted twice through Resource Timing', () => {
  const documentRef = fakeDocument();
  const entries = [
    {
      name: '/api/feed',
      startTime: 12,
      initiatorType: 'fetch',
      transferSize: 9000,
    },
    {
      name: '/assets/tile.png',
      startTime: 13,
      initiatorType: 'img',
      transferSize: 1000,
    },
  ];
  const target = {
    fetch: async () =>
      new Response('x', { headers: { 'content-length': '9000' } }),
  };
  const meter = createDataUsageMeter({
    documentRef,
    performanceRef: fakePerformance(entries),
    fetchTarget: target,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  });

  const readout = documentRef.hudData.children.at(-1);
  // The tile is counted from the entry, the fetch is not: 1 kB of a 10 kB
  // session is on the wire through a layer the tap does not own.
  assert.match(readout.children[3].textContent, /^1 kB$/);
  // The tap restores what it replaced when the meter goes away.
  meter.destroy();
  assert.equal(typeof target.fetch, 'function');
});
