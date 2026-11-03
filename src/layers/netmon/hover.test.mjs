import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import { createNetmonLayer, netmonHoverTip } from './index.js';

/** A viewer stub with a canvas, a camera buzzer and a scripted pick(). */
function makeViewer(pickAt) {
  return {
    camera: {
      moveEnd: new Cesium.Event(),
      moveStart: new Cesium.Event(),
      changed: new Cesium.Event(),
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(13.35, 52.47, 13.45, 52.53),
    },
    scene: {
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      requestRender() {},
      canvas: {
        style: {},
        getBoundingClientRect: () => ({ left: 7, top: 11 }),
      },
      pick(at) {
        return pickAt(at.x, at.y);
      },
      primitives: {
        add(value) {
          return value;
        },
        remove() {},
      },
    },
  };
}

/** A real Cesium-like handler stub the test can actuate directly. */
function fakePointerHandler() {
  const actions = new Map();
  return {
    destroyed: false,
    setInputAction(action, type) {
      actions.set(type, action);
    },
    fire(type, movement) {
      actions.get(type)?.(movement);
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

/** A tip view spy recording every call in order. */
function fakeTipView() {
  const calls = [];
  const view = {
    visible: false,
    show(text, x, y) {
      calls.push(['show', text, x, y]);
      view.visible = true;
    },
    hide() {
      calls.push(['hide']);
      view.visible = false;
    },
    destroy() {
      calls.push(['destroy']);
    },
    calls,
  };
  return view;
}

const probed = {
  id: 'netmon:a.example.net:443',
  lat: 52.5,
  lon: 13.4,
  label: 'HQ',
  meta: {
    status: 'up',
    latencyMs: 12,
    error: null,
    host: 'a.example.net:443',
    // 2026-05-06T13:07:09Z — a fixed clock so the tip text is exact.
    checkedAt: Date.UTC(2026, 4, 6, 13, 7, 9),
  },
};

function netmonHarness(viewer, handler, tipView) {
  const layer = createNetmonLayer({
    source: { getSnapshot: async () => ({ rows: [probed], ageMs: 0 }) },
    tipView,
    pointerHandlerFactory: () => handler,
  });
  layer.init(viewer);
  layer.enable();
  return layer;
}

test('netmonHoverTip reads the row: host, latency, last probe', () => {
  const text = netmonHoverTip(probed).split('\n');
  assert.deepEqual(text, [
    'a.example.net:443',
    'Latency: 12 ms',
    'Last probe: 13:07:09 UTC',
  ]);
});

test('a node without a probe round never invents numbers', () => {
  // No host in the meta, so the tip falls back to the row's own label.
  const text = netmonHoverTip({
    id: 'netmon:lab.example.net:22',
    lat: 0,
    lon: 0,
    label: 'Lab',
    meta: {},
  }).split('\n');
  assert.deepEqual(text, [
    'Lab',
    'Latency: unknown',
    'Not probed yet',
  ]);
  // With a host the header names the probed endpoint, not the label.
  assert.equal(
    netmonHoverTip({ ...probed, meta: { host: 'a.example.net:443' } }).split(
      '\n',
    )[0],
    'a.example.net:443',
  );
  assert.equal(netmonHoverTip(null), '');
});

test('hovering a netmon marker shows the tip; leaving hides it', async () => {
  const marker = { x: 40, y: 30 };
  const viewer = makeViewer(
    (x, y) =>
      x === marker.x && y === marker.y ? { id: `netmon:${probed.id}` } : null,
  );
  const handler = fakePointerHandler();
  const tipView = fakeTipView();
  const layer = netmonHarness(viewer, handler, tipView);
  await layer.update();

  // Nothing is shown before the pointer moves (the view starts dormant).
  assert.equal(tipView.calls.length, 0);
  const MOVE = Cesium.ScreenSpaceEventType.MOUSE_MOVE;

  // Off-marker: only a hide is possible; nothing to show.
  handler.fire(MOVE, { endPosition: { x: 300, y: 200 } });
  assert.deepEqual(tipView.calls, [['hide']]);

  // After the 50 ms throttle window, on-marker shows the row's own tip, at
  // the pointer (canvas offset 7/11 included) with the hover cursor.
  await new Promise((resolve) => setTimeout(resolve, 60));
  handler.fire(MOVE, { endPosition: marker });
  const shown = tipView.calls.find(([verb]) => verb === 'show');
  assert.ok(shown, 'the marker under the pointer shows its tip');
  assert.match(shown[1], /^a\.example\.net:443\n/);
  assert.match(shown[1], /\nLatency: 12 ms\n/);
  assert.match(shown[1], /\nLast probe: 13:07:09 UTC$/);
  assert.equal(shown[2], 47, 'tip x = canvas left + pointer x');
  assert.equal(shown[3], 41, 'tip y = canvas top + pointer y');
  assert.equal(viewer.scene.canvas.style.cursor, 'pointer');

  // Leaving the marker again (fresh pick) hides the tip and the cursor.
  await new Promise((resolve) => setTimeout(resolve, 60));
  handler.fire(MOVE, { endPosition: { x: 300, y: 200 } });
  assert.deepEqual(tipView.calls.at(-1), ['hide']);
  assert.equal(viewer.scene.canvas.style.cursor, '');

  // Disable is an unconditional hide; destroy releases the tip element and
  // the pointer handler. No listener outlives the layer.
  layer.disable();
  assert.deepEqual(tipView.calls.at(-1), ['hide']);
  layer.destroy();
  assert.ok(
    tipView.calls.some(([verb]) => verb === 'destroy'),
    'the tip element is released',
  );
  assert.equal(handler.destroyed, true);
});

test('a tool that owns the pointer gets no hover at all', async () => {
  const { claimPointer, releasePointer } = await import(
    '../../data/inputOwnership.js'
  );
  const lease = claimPointer('hover-test-tool');
  try {
    const marker = { x: 40, y: 30 };
    const viewer = makeViewer(
      (x, y) =>
        x === marker.x && y === marker.y ? { id: `netmon:${probed.id}` } : null,
    );
    const handler = fakePointerHandler();
    const tipView = fakeTipView();
    const layer = netmonHarness(viewer, handler, tipView);
    await layer.update();

    handler.fire(Cesium.ScreenSpaceEventType.MOUSE_MOVE, { endPosition: marker });
    assert.deepEqual(tipView.calls, [['hide']], 'the claimed pointer shows nothing');
    layer.destroy();
  } finally {
    releasePointer(lease);
  }
});
