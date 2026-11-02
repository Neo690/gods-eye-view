import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import { NETMON_LEGEND, createNetmonLayer, netmonPointColour } from './index.js';
import { NETMON_ROUTE, createNetmonSource } from './source.js';
import { layerFeedState } from '../../data/feedState.js';

/** A viewer that reports one fixed view and records what gets drawn. */
function harness(getSnapshot, { rectangle } = {}) {
  const primitives = [];
  const viewer = {
    camera: {
      moveEnd: new Cesium.Event(),
      changed: new Cesium.Event(),
      computeViewRectangle: () =>
        rectangle ?? Cesium.Rectangle.fromDegrees(13.35, 52.47, 13.45, 52.53),
    },
    scene: {
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      requestRender() {},
      primitives: {
        add(value) {
          primitives.push(value);
          return value;
        },
        remove(value) {
          const index = primitives.indexOf(value);
          if (index >= 0) primitives.splice(index, 1);
        },
      },
    },
  };
  const layer = createNetmonLayer({
    source: { getSnapshot: (...args) => getSnapshot(...args) },
  });
  layer.init(viewer);
  return { layer, viewer, primitives, collection: () => primitives[0] };
}

const rows = (statusA) => [
  {
    id: 'netmon:a.example.net:443',
    lat: 52.5,
    lon: 13.4,
    label: 'HQ',
    meta: { status: statusA, latencyMs: 12, error: null, host: 'a:443' },
  },
  {
    id: 'netmon:b.example.net:8080',
    lat: 52.51,
    lon: 13.41,
    label: 'Rack B',
    meta: { status: 'down', latencyMs: 5000, error: 'timeout', host: 'b:8080' },
  },
];

test('an enabled layer draws its probe answers with per-point colours', async () => {
  let asked = null;
  let payload = rows('up');
  const h = harness(async (request, { signal } = {}) => {
    asked = request;
    return { rows: payload, ageMs: 0 };
  });
  assert.equal(await h.layer.update(), false, 'disabled layers do not fetch');
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  assert.equal(h.collection().length, 2);
  // Status, not position, decides each marker's colour.
  assert.equal(
    h.collection().get(0).color.toCssHexString(),
    Cesium.Color.fromCssColorString('#4de18e').toCssHexString(),
  );
  assert.equal(
    h.collection().get(1).color.toCssHexString(),
    Cesium.Color.fromCssColorString('#ff5f6d').toCssHexString(),
  );
  const controls = h.layer.getRowControls();
  assert.deepEqual(controls.legend, NETMON_LEGEND);
  assert.match(controls.info, /2 in view · Operator nodes/);
  const stats = h.layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.error, null);
  assert.equal(layerFeedState(stats), 'nominal');

  // A status flip is a redraw even though nothing moved.
  payload = rows('down');
  await h.layer.update();
  assert.equal(
    h.collection().get(0).color.toCssHexString(),
    Cesium.Color.fromCssColorString('#ff5f6d').toCssHexString(),
  );
  const records = h.layer.getAnalystRecords();
  assert.equal(records[0].meta.status, 'down');
  h.layer.destroy();
  assert.equal(h.primitives.length, 0);
});

test('netmonPointColour never falls back to the theme', () => {
  assert.equal(netmonPointColour({ id: 'x' }), '#8a94a6');
  assert.equal(netmonPointColour({ meta: { status: 'up' } }), '#4de18e');
  assert.equal(netmonPointColour({ meta: { status: 'down' } }), '#ff5f6d');
  assert.equal(netmonPointColour({ meta: { status: 'wat' } }), '#8a94a6');
});

test('an unconfigured server explains the setup step instead of retrying forever', async () => {
  const h = harness(async () => {
    throw Object.assign(
      new Error('Network-monitor feed unavailable (HTTP 503)'),
      { status: 503, retryable: true, retryableAfterSetup: true },
    );
  });
  h.layer.enable();
  await h.layer.update();
  const stats = h.layer.getStats();
  assert.match(stats.error, /HTTP 503/);
  // The read itself answered, so the layer stays enabled for the row text.
  h.layer.destroy();
});

test('the browser source reads the one proxy route and maps its payload', async () => {
  const source = createNetmonSource({
    fetchImpl: async (route) => {
      assert.equal(route, NETMON_ROUTE);
      return new Response(
        JSON.stringify({
          points: rows('up'),
          ageMs: 4000,
          stale: true,
          truncated: false,
          configured: true,
          totalTargets: 3,
          placedTargets: 2,
        }),
        { status: 200 },
      );
    },
  });
  const snapshot = await source.getSnapshot({}, {});
  assert.equal(snapshot.rows.length, 2);
  assert.equal(snapshot.ageMs, 4000);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.unplacedCount, 1);
});
