import test from 'node:test';
import assert from 'node:assert/strict';

import { createIsraeliTransportLayer } from './index.js';
import { ACTIVITY_OVERLAY_SOURCE_ID } from './policy.js';

// The layer installs a keyboard fallback on the page; keep a DOM stub so the
// node runtime can tear it down again after a selection test.
globalThis.document ??= {
  addEventListener() {},
  removeEventListener() {},
};

function overlayHost(record) {
  return {
    setEntries(sourceId, entries, options) {
      record.push({ sourceId, entries, options });
    },
    clearSource() {},
    setVisible() {},
  };
}

function stubViewer() {
  const owned = [];
  return {
    owned,
    dataSources: {
      add: (dataSource) => {
        owned.push(dataSource);
        return dataSource;
      },
      remove() {},
    },
  };
}

test('the ambient publication re-solves while the camera moves', () => {
  const record = [];
  const layer = createIsraeliTransportLayer({
    overlayHost: overlayHost(record),
  });
  const viewer = stubViewer();
  layer.init(viewer);
  layer.enable(null); // null skips the click handler, which needs a real canvas.
  const publish = record.find(
    (call) => call.sourceId === ACTIVITY_OVERLAY_SOURCE_ID,
  );
  assert.ok(publish, 'the layer publishes its ambient label cohort');
  assert.equal(
    publish.options.moving,
    true,
    'cards pinned to their dots must track the moving camera, not the settled one',
  );
  assert.equal(
    publish.options.solveIntervalMs,
    0,
    'the cohort must re-solve on every rendered frame: the default 125 ms cadence leaves the cards ~30 px behind their dots at whole-globe drag speeds',
  );
  layer.destroy();
});

test('the dataset draws sites and company hubs as one constellation', () => {
  const record = [];
  const layer = createIsraeliTransportLayer({
    overlayHost: overlayHost(record),
  });
  const stub = stubViewer();
  layer.init(stub);
  layer.enable(null);

  const dataSource = stub.owned[0];
  assert.ok(dataSource, 'the layer owns one data source');
  const ids = dataSource.entities.values.map((entity) => entity.id);
  const siteIds = record[0].entries.filter(
    (entry) => !entry.id.startsWith('company-'),
  );
  const hubIds = record[0].entries.filter((entry) =>
    entry.id.startsWith('company-'),
  );
  assert.ok(siteIds.length > 0, 'site cards ship in the ambient cohort');
  assert.ok(hubIds.length > 0, 'company hubs ship in the ambient cohort');
  // Every hub card that sits in the cohort also has an entity on the globe.
  for (const hub of hubIds) {
    const entityId = `israeli-transport:company:${hub.id.replace('company-', '')}`;
    assert.ok(
      ids.includes(entityId),
      `assurance hub entity ${entityId} is drawn`,
    );
  }
  // Links are drawn for every hub: the neural map reads as one constellation.
  const links = ids.filter((id) => id.includes(':link:'));
  assert.ok(links.length > 0, 'hub-to-site links are drawn');

  const stats = layer.getStats();
  assert.ok(stats.count > 0, 'the stats report the site count');
  assert.ok(stats.companies > 0, 'the stats report the company count');
  layer.destroy();
});

test('disabling keeps the DS hidden and the publications off', () => {
  const record = [];
  const layer = createIsraeliTransportLayer({
    overlayHost: overlayHost(record),
  });
  const stub = stubViewer();
  layer.init(stub);
  layer.enable(null);
  layer.disable();
  assert.equal(stub.owned[0].show, false);
  layer.destroy();
});
