import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';

import { CELL_TOWER_PROVIDERS, createCellTowersLayer } from './index.js';
import { CELL_TOWERS_ROUTE, createCellTowerSource } from './source.js';

function harness(getSnapshot) {
  const primitives = [];
  const viewer = {
    camera: {
      moveEnd: new Cesium.Event(),
      changed: new Cesium.Event(),
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(2.3, 48.83, 2.38, 48.88),
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
  const layer = createCellTowersLayer({
    source: { getSnapshot: (...args) => getSnapshot(...args) },
  });
  layer.init(viewer);
  return { layer, primitives, collection: () => primitives[0] };
}

const sites = [
  {
    id: '829977',
    lat: 48.85861,
    lon: 2.34639,
    label: '829977',
    meta: { bands: ['5G NR'] },
  },
  {
    id: '829978',
    lat: 48.86,
    lon: 2.35,
    label: '829978',
    meta: { bands: ['FM'] },
  },
];

test('radio sites draw what the proxy returned for the view', async () => {
  let asked = null;
  const h = harness(async (request) => {
    asked = request;
    return { rows: sites };
  });
  h.layer.enable();
  assert.equal(await h.layer.update(), true);
  // Cesium round-trips the rectangle through radians, so compare with a
  // tolerance rather than on the last bit.
  for (const [side, value] of Object.entries({
    west: 2.3,
    south: 48.83,
    east: 2.38,
    north: 48.88,
  }))
    assert.ok(Math.abs(asked.bounds[side] - value) < 1e-9, side);
  assert.equal(asked.provider, 'anfr', 'ANFR is the first provider offered');
  assert.equal(h.collection().length, 2);
  assert.equal(h.collection().get(0).id, 'cell-towers:829977');
  assert.equal(h.layer.getStats().count, 2);
  assert.match(h.layer.getRowControls().info, /ANFR/);
  assert.deepEqual(
    CELL_TOWER_PROVIDERS.map((provider) => provider.id),
    ['anfr', 'opencellid'],
  );
  h.layer.destroy();
  assert.equal(h.primitives.length, 0);
});

test('a not-configured server is reported, and the second provider is one chip away', async () => {
  const seen = [];
  const h = harness(async (request) => {
    seen.push(request.provider);
    throw Object.assign(new Error('Radio-site feed unavailable (HTTP 503)'), {
      retryable: true,
    });
  });
  h.layer.enable();
  assert.equal(await h.layer.update(), true, 'the layer stays enabled');
  assert.equal(h.layer.getStats().count, 0);
  assert.match(h.layer.getRowControls().info, /HTTP 503/);
  const chips = h.layer.getRowControls().chips;
  assert.equal(chips[0].active, true);
  chips[1].onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['anfr', 'opencellid']);
  h.layer.destroy();
});

test('the browser source asks this app, and surfaces the setup hint as an error', async () => {
  const calls = [];
  const source = createCellTowerSource({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          points: sites,
          matched: 2,
          source: 'anfr',
          attribution: { label: 'ANFR', licence: 'Licence Ouverte 2.0' },
        }),
        { status: 200 },
      );
    },
  });
  const snapshot = await source.getSnapshot({
    bounds: { west: 2.3, south: 48.83, east: 2.38, north: 48.88 },
    provider: 'anfr',
  });
  assert.equal(calls[0].startsWith(CELL_TOWERS_ROUTE), true);
  assert.match(calls[0], /source=anfr/);
  assert.equal(snapshot.rows.length, 2);

  const unconfigured = createCellTowerSource({
    fetchImpl: async () => new Response('{}', { status: 503 }),
  });
  await assert.rejects(
    () =>
      unconfigured.getSnapshot({
        bounds: { west: 2.3, south: 48.83, east: 2.38, north: 48.88 },
        provider: 'anfr',
      }),
    (error) => error.status === 503 && error.retryableAfterSetup === true,
  );
});
