import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import { createIotSensorsLayer } from './index.js';
import { IOT_ROUTE, createIotSensorSource } from './source.js';
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
  const layer = createIotSensorsLayer({
    source: { getSnapshot: (...args) => getSnapshot(...args) },
  });
  layer.init(viewer);
  return { layer, viewer, primitives, collection: () => primitives[0] };
}

const rows = [
  { id: 'osm:1', lat: 52.5, lon: 13.4, label: 'Box 1', meta: {} },
  { id: 'osm:2', lat: 52.51, lon: 13.41, label: 'Box 2', meta: {} },
];

test('an enabled layer draws the points inside the view', async () => {
  let asked = null;
  const h = harness(async (request) => {
    asked = request;
    return { rows, ageMs: 0 };
  });
  assert.equal(await h.layer.update(), false, 'disabled layers do not fetch');
  assert.equal(asked, null);
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  assert.equal(asked.provider, 'opensensemap');
  assert.deepEqual(asked.bounds, {
    west: 13.35,
    south: 52.47,
    east: 13.45,
    north: 52.53,
  });
  assert.equal(h.collection().length, 2);
  assert.equal(h.collection().get(0).id, 'iot-sensors:osm:1');
  const stats = h.layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.error, null);
  assert.equal(stats.provider, 'opensensemap');
  assert.equal(stats.coverage.clamped, false);
  assert.equal(layerFeedState(stats), 'nominal');
  assert.match(h.layer.getRowControls().info, /2 in view · openSenseMap/);
  h.layer.destroy();
  assert.equal(h.primitives.length, 0);
});

test('the view is clamped before it becomes a request', async () => {
  const wide = harness(async () => ({ rows: [] }), {
    rectangle: Cesium.Rectangle.fromDegrees(-180, -80, 180, 80),
  });
  wide.layer.enable();
  await wide.layer.update();
  const { coverage } = wide.layer.getStats();
  assert.equal(coverage.clamped, true);
  assert.ok(coverage.east - coverage.west <= 6.0001);
  assert.match(wide.layer.getRowControls().infoTitle, /wider than one request/);
  wide.layer.destroy();
});

test('switching provider asks the same route for the other source', async () => {
  const asked = [];
  const h = harness(async (request) => {
    asked.push(request.provider);
    return { rows: [] };
  });
  h.layer.enable();
  await h.layer.update();
  const chips = h.layer.getRowControls().chips;
  assert.deepEqual(
    chips.map((chip) => chip.label),
    ['openSenseMap', 'TTN LoRaWAN'],
  );
  assert.equal(chips[0].active, true);
  chips[1].onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, ['opensensemap', 'ttn']);
  assert.equal(h.layer.getStats().provider, 'ttn');
  h.layer.destroy();
});

test('an upstream failure is reported without disabling the layer', async () => {
  let calls = 0;
  const h = harness(async () => {
    calls += 1;
    if (calls === 1)
      throw Object.assign(
        new Error('Connected-objects feed unavailable (HTTP 502)'),
        {
          retryable: true,
        },
      );
    return { rows };
  });
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(layerFeedState(h.layer.getStats()), 'unavailable');
  assert.match(h.layer.getRowControls().info, /HTTP 502/);
  h.layer.destroy();
});

test('the browser source asks this app for the view, never a third party', async () => {
  const calls = [];
  const source = createIotSensorSource({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ points: rows, ageMs: 12, stale: true }),
        { status: 200 },
      );
    },
  });
  const snapshot = await source.getSnapshot({
    bounds: { west: 1, south: 2, east: 3, north: 4 },
    provider: 'ttn',
  });
  assert.equal(calls[0].url.startsWith(IOT_ROUTE), true);
  assert.match(calls[0].url, /source=ttn/);
  assert.equal(snapshot.rows.length, 2);
  assert.equal(snapshot.ageMs, 12);
  assert.equal(snapshot.stale, true);

  const limited = createIotSensorSource({
    fetchImpl: async () => new Response('{}', { status: 429 }),
  });
  await assert.rejects(
    () =>
      limited.getSnapshot({
        bounds: { west: 1, south: 2, east: 3, north: 4 },
        provider: 'opensensemap',
      }),
    (error) => error.retryable === true && /429/.test(error.message),
  );
});
