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
  return {
    dataSources: { add: (dataSource) => dataSource, remove() {} },
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
  assert.equal(await layer.update(), false);
  assert.equal(calls, 0);
  assert.match(layer.getRowControls().info, /Zoom in/);
  assert.equal(layer.getStats().count, 0);
  layer.destroy(viewer(WIDE_VIEW));
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
  assert.equal(await layer.update(), false);
  const controls = layer.getRowControls();
  assert.match(controls.infoTitle, /Global Fishing Watch token/);
  assert.equal(layer.getStats().error, 'missing-key');
  layer.destroy(viewer(SMALL_VIEW));
});
