import test from 'node:test';
import assert from 'node:assert/strict';
import { createFishingEffortLayer } from './index.js';

const SMALL_VIEW = {
  west: -0.2,
  east: 0.2,
  south: -0.1,
  north: 0.1,
};
const WIDE_VIEW = {
  west: -1.6,
  east: 1.6,
  south: -0.9,
  north: 0.9,
};

function viewer(view) {
  const added = [];
  return {
    added,
    dataSources: {
      add: (dataSource) => {
        added.push(dataSource);
        return dataSource;
      },
      remove() {},
    },
    camera: { computeViewRectangle: () => view },
  };
}

const snapshot = (cells = [{ lat: 0, lon: 0, hours: 12 }]) => ({
  ok: true,
  error: null,
  cells,
  totalHours: cells.reduce((sum, cell) => sum + cell.hours, 0),
  cellCount: cells.length,
  truncated: false,
  days: 7,
});

test('an update draws the effort cells and reports the totals', async () => {
  const layer = createFishingEffortLayer({
    source: { getSnapshot: async () => snapshot() },
    now: () => 1,
  });
  layer.init(viewer(SMALL_VIEW));
  layer.enable();
  assert.equal(await layer.update(), true);
  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.totalHours, 12);
  assert.match(layer.getRowControls().info, /12 h · 1 cells · 7d/);
  assert.equal(layer.getAnalystRecords().length, 1);
  layer.disable();
  assert.equal(layer.getStats().count, 1, 'disabling keeps the last totals');
  assert.equal(layer.getAnalystRecords().length, 0);
  layer.destroy(viewer(SMALL_VIEW));
});

test('dense cells are grouped into a zone, with a fill and an outline', async () => {
  const cells = [
    { lat: 0, lon: 0, hours: 10 },
    { lat: 0, lon: 0.1, hours: 10 },
    { lat: 0.1, lon: 0, hours: 10 },
    { lat: 0.1, lon: 0.1, hours: 10 },
  ];
  const withZones = viewer(SMALL_VIEW);
  const layer = createFishingEffortLayer({
    source: { getSnapshot: async () => snapshot(cells) },
  });
  layer.init(withZones);
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().zoneCount, 1);
  assert.match(layer.getRowControls().info, /Zones: 1/);

  const ids = withZones.added[0].entities.values.map((entity) => entity.id);
  assert.ok(
    ids.some((id) => id.startsWith('fishing-zone-fill:')),
    'the zone is filled',
  );
  assert.ok(
    ids.some((id) => id.startsWith('fishing-zone:')),
    'and outlined',
  );
  layer.destroy(withZones);

  // Two cells only: still fishing, but not an area worth an outline.
  const thin = viewer(SMALL_VIEW);
  const sparse = createFishingEffortLayer({
    source: {
      getSnapshot: async () =>
        snapshot([
          { lat: 0, lon: 0, hours: 10 },
          { lat: 0, lon: 0.1, hours: 10 },
        ]),
    },
  });
  sparse.init(thin);
  sparse.enable();
  assert.equal(await sparse.update(), true);
  assert.equal(sparse.getStats().zoneCount, 0);
  assert.doesNotMatch(sparse.getRowControls().info, /Zones/);
  sparse.destroy(thin);
});

test('a wide view asks for a closer one instead of a hemisphere of cells', async () => {
  let calls = 0;
  const layer = createFishingEffortLayer({
    source: {
      getSnapshot: async () => {
        calls++;
        return snapshot();
      },
    },
  });
  layer.init(viewer(WIDE_VIEW));
  layer.enable();
  // `true`: the layer handled the update. `false` is the manager's signal for a
  // refused transition, and it would switch the layer back off — which is how
  // the "Zoom in" row became unreachable from a global view.
  assert.equal(await layer.update(), true);
  assert.equal(calls, 0);
  assert.match(layer.getRowControls().info, /Zoom in/);
  assert.equal(layer.getStats().count, 0);
  layer.destroy(viewer(WIDE_VIEW));
});

test('a camera with no rectangle is a note, not a refused transition', async () => {
  const layer = createFishingEffortLayer({
    source: { getSnapshot: async () => snapshot() },
  });
  layer.init(viewer(null));
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.match(layer.getRowControls().info, /No view/);
  layer.destroy(viewer(null));
});

test('a failed refresh stays on and reports the error', async () => {
  const layer = createFishingEffortLayer({
    source: {
      getSnapshot: async () => {
        throw new Error('GFW answered 503');
      },
    },
  });
  const withView = viewer(SMALL_VIEW);
  layer.init(withView);
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(layer.getStats().error, 'GFW answered 503');
  layer.destroy(withView);
});

test('a missing token is a stated key, not an empty ocean', async () => {
  const layer = createFishingEffortLayer({
    source: {
      getSnapshot: async () => ({
        ok: false,
        error: 'missing-key',
        cells: [],
        totalHours: 0,
        cellCount: 0,
      }),
    },
  });
  layer.init(viewer(SMALL_VIEW));
  layer.enable();
  // A missing token is a stated key, not a refusal: the layer stays on so its
  // row can ask for one, instead of disappearing from the panel.
  assert.equal(await layer.update(), true);
  const controls = layer.getRowControls();
  assert.match(controls.infoTitle, /Global Fishing Watch token/);
  assert.equal(layer.getStats().error, 'missing-key');
  layer.destroy(viewer(SMALL_VIEW));
});
