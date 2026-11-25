import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  CONFLICT_EVENT_SELECTED_EVENT,
  conflictEventIdFromPick,
  createConflictEventsLayer,
} from './index.js';

function eventRow(id, fatalities, overrides = {}) {
  return {
    stableId: id,
    provider: 'acled',
    lat: 10,
    lon: 20,
    timeMs: Date.parse('2026-11-20T00:00:00Z'),
    type: 'Battles',
    subType: 'Armed clash',
    actors: 'Group A / Group B',
    fatalities,
    country: 'Testland',
    sourceUrl: null,
    ...overrides,
  };
}

function harness(rows = [eventRow('e1', 3), eventRow('e2', 9)], source = null) {
  const events = [];
  const handler = {
    click: null,
    type: null,
    destroyed: false,
    setInputAction(callback, type) {
      this.click = callback;
      this.type = type;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  const credits = new Set();
  const viewer = {
    dataSources: { add() {}, remove() {} },
    creditDisplay: {
      addStaticCredit: (credit) => credits.add(credit),
      removeStaticCredit: (credit) => credits.delete(credit),
    },
    scene: {
      canvas: {},
      pick: () => ({ id: { id: 'conflict:e2' } }),
      requestRender() {},
    },
  };
  const layer = createConflictEventsLayer({
    source: source ?? { getSnapshot: async () => rows },
    overlayHost: {
      setVisible() {},
      clearSource() {},
      setEntries() {},
    },
    screenSpaceEventHandlerFactory: () => handler,
    eventTarget: { dispatchEvent: (event) => events.push(event) },
  });
  return { layer, viewer, handler, events, credits };
}

test('a picked conflict dot selects its event and announces it once', async () => {
  // The conflict window listens for this exact literal (src/ui/conflictPanel.js)
  // without importing Cesium, so the name itself is the contract.
  assert.equal(CONFLICT_EVENT_SELECTED_EVENT, 'gev:conflict-event-selected');
  const { layer, viewer, handler, events } = harness();
  layer.init(viewer);
  await layer.update();
  layer.enable();

  assert.equal(handler.type, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  handler.click({ position: { x: 120, y: 80 } });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, CONFLICT_EVENT_SELECTED_EVENT);
  assert.deepEqual(events[0].detail, { eventId: 'e2' });

  // A sibling layer's pick is not this layer's event.
  viewer.scene.pick = () => ({ id: { id: 'flight:abc' } });
  handler.click({ position: { x: 120, y: 80 } });
  assert.equal(events.length, 1);

  layer.disable();
  assert.equal(handler.destroyed, true);
});

test('the active layer carries the ACLED credit on the globe', async () => {
  const { layer, viewer, credits } = harness();
  layer.init(viewer);
  await layer.update();
  layer.enable();

  assert.equal(credits.size, 1);
  const [credit] = [...credits];
  assert.equal(credit.showOnScreen, true);
  assert.match(credit.html, /ACLED/);
  assert.match(credit.html, /Armed Conflict Location &amp; Event Data/);
  assert.match(credit.html, /href="https:\/\/acleddata\.com"/);

  layer.disable();
  assert.equal(credits.size, 0);
  layer.enable();
  assert.equal(credits.size, 1);
  layer.destroy();
  assert.equal(credits.size, 0);
});

test('the layer keeps the proxy generatedAt and refresh forces a new read', async () => {
  const generatedAt = Date.parse('2026-11-20T10:00:00Z');
  const calls = [];
  const { layer, viewer } = harness(undefined, {
    async getSnapshot(options = {}) {
      calls.push(options);
      return { rows: [eventRow('e1', 3)], generatedAt };
    },
  });
  layer.init(viewer);
  await layer.update();

  assert.equal(layer.getStats().generatedAt, generatedAt);
  assert.equal(calls[0].force, false);

  await layer.refresh();
  assert.equal(calls[1].force, true);
});

test('a manual refresh while the layer is off still records a failure', async () => {
  const { layer, viewer } = harness(undefined, {
    async getSnapshot() {
      throw Object.assign(new Error('Conflicts no_key'), { code: 'no_key' });
    },
  });
  layer.init(viewer);

  assert.equal(await layer.refresh(), false);
  assert.equal(layer.getLastError(), 'no_key');
});

test('the readout carries each event day and actors, not only type and country', async () => {
  const { layer, viewer } = harness([
    eventRow('e1', 3),
    eventRow('e2', 9, { actors: null }),
    eventRow('e3', 0),
  ]);
  layer.init(viewer);
  await layer.update();

  const [first, second] = layer.getRecentEvents(2);
  assert.equal(first.id, 'e2');
  assert.equal(first.date, 'Nov 20');
  assert.equal(first.actors, null);
  assert.equal(first.details, 'Nov 20');
  assert.equal(second.id, 'e1');
  assert.match(second.details, /Nov 20/);
  assert.match(second.details, /Group A \/ Group B/);

  // A selected event outside the top slice still has a row to land on.
  const withSelected = layer.getRecentEvents(1, 'e3');
  assert.equal(withSelected[0].id, 'e3');
  assert.ok(withSelected.some((item) => item.id === 'e2'));
  assert.equal(withSelected[0].ordinal, 3);
});

test('pick ids resolve from both entity and primitive shapes', () => {
  assert.equal(conflictEventIdFromPick({ id: 'conflict:e1' }), 'e1');
  assert.equal(conflictEventIdFromPick({ id: { id: 'conflict:e2' } }), 'e2');
  assert.equal(
    conflictEventIdFromPick({ primitive: { id: 'conflict:e3' } }),
    'e3',
  );
  assert.equal(conflictEventIdFromPick({ id: 'flight:abc' }), null);
  assert.equal(conflictEventIdFromPick(null), null);
});
