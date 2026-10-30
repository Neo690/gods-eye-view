import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDataUsageMeter,
  formatBytes,
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
  const byId = new Map([
    ['title-bar', titleBar],
    ['top-center-actions', actionRow],
    ['gev-voice-control', voiceControl],
  ]);
  return {
    hidden: false,
    titleBar,
    actionRow,
    voiceControl,
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

test('the readout sits above the voice control and reports bytes already transferred', () => {
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

  const readout = documentRef.voiceControl.children.at(-1);
  assert.equal(readout.id, 'data-usage');
  // The application chrome keeps none of it: the line is anchored to the mic,
  // not parked in the title bar or the action row.
  assert.deepEqual(documentRef.actionRow.children, []);
  assert.deepEqual(documentRef.titleBar.children, []);
  // Rate, separator, total — and no symbols the reader has to decode.
  assert.equal(readout.children.length, 3);
  assert.match(readout.children[0].textContent, /^0 B\/s$/);
  assert.equal(readout.children[1].textContent, '·');
  assert.match(readout.children[2].textContent, /^6 kB$/);

  meter.destroy();
  assert.equal(readout.removed, true);
});

test('without a timeline there is nothing to measure', () => {
  const meter = createDataUsageMeter({
    documentRef: { getElementById: () => null },
    performanceRef: fakePerformance([]),
  });
  assert.equal(typeof meter.destroy, 'function');
  meter.destroy();
});

test('a voice control built after the meter still gets the line', () => {
  // Voice is wired up when its runner exists, which is later than the shell's
  // UI init: the meter must wait for the mic instead of giving up.
  const documentRef = fakeDocument();
  const late = documentRef.voiceControl;
  documentRef.byId.delete('gev-voice-control');

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
  assert.deepEqual(documentRef.voiceControl.children, []);

  documentRef.byId.set('gev-voice-control', late);
  tick();
  assert.equal(documentRef.voiceControl.children.length, 1);
  assert.equal(documentRef.voiceControl.children[0].id, 'data-usage');

  // A rebuilt control is adopted again rather than left with a dead line.
  const rebuilt = documentRef.make('div');
  documentRef.byId.set('gev-voice-control', rebuilt);
  tick();
  assert.equal(rebuilt.children.length, 1);

  meter.destroy();
});
