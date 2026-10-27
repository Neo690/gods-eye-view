import assert from 'node:assert/strict';
import test from 'node:test';

import { PANEL_WINDOW_IDS } from './panelWindows.js';
import {
  RAIL_ACCORDION_CLASS,
  applyRailAccordion,
  railAccordionPlan,
  railAccordionReleasePlan,
  readRailPanels,
} from './panelRailAccordion.js';

/** Just enough document for the applier: elements that own a class set. */
function fakeDocument(panels = {}) {
  const make = (id) => {
    const classes = new Set();
    return {
      id,
      classList: {
        contains: (name) => classes.has(name),
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
      },
      classes,
    };
  };
  return {
    getElementById: (id) => panels[id] ?? null,
    panels,
    make,
  };
}

function panel(make, id, { collapsed = false, marked = false } = {}) {
  const node = make(id);
  if (collapsed) node.classList.add('collapsed');
  if (marked) node.classList.add(RAIL_ACCORDION_CLASS);
  return {
    id,
    element: node,
    collapsed,
    accordionCollapsed: marked,
  };
}

test('the rail list is the six windows, in reading order', () => {
  assert.deepEqual(PANEL_WINDOW_IDS, [
    'data-panel',
    'scene-panel',
    'pp-toggles',
    'cctv-panel',
    'street-level-panel',
    'global-context-panel',
  ]);
});

test('opening a window closes the siblings that were open', () => {
  const panels = [
    panel(fakeDocument().make, 'data-panel'),
    panel(fakeDocument().make, 'scene-panel'),
    panel(fakeDocument().make, 'pp-toggles', { collapsed: true }),
    panel(fakeDocument().make, 'cctv-panel', { collapsed: true }),
    panel(fakeDocument().make, 'street-level-panel'),
    panel(fakeDocument().make, 'global-context-panel'),
  ];
  assert.deepEqual(railAccordionPlan(panels, 'data-panel'), {
    collapse: ['scene-panel', 'street-level-panel', 'global-context-panel'],
    unmark: [],
    release: [],
  });
});

test('a window the operator closed by hand is left alone', () => {
  const make = fakeDocument().make;
  const panels = [
    panel(make, 'data-panel'),
    panel(make, 'cctv-panel', { collapsed: true }),
    panel(make, 'pp-toggles', { collapsed: true, marked: true }),
  ];
  const plan = railAccordionPlan(panels, 'data-panel');
  assert.deepEqual(plan.collapse, []);
  assert.deepEqual(
    plan.release,
    [],
    'a marked window the operator has not reopened stays put: releasing it here would pop it open',
  );
});

test('opening a window the accordion had closed drops its marker', () => {
  const make = fakeDocument().make;
  const panels = [
    panel(make, 'data-panel', { collapsed: true, marked: true }),
    panel(make, 'scene-panel'),
  ];
  assert.deepEqual(railAccordionPlan(panels, 'data-panel'), {
    collapse: ['scene-panel'],
    unmark: ['data-panel'],
    release: [],
  });
});

test('anything that is not a rail window plans nothing', () => {
  const make = fakeDocument().make;
  const panels = [panel(make, 'data-panel'), panel(make, 'scene-panel')];
  for (const owner of [null, undefined, '', 'radio-panel', 'not-a-panel']) {
    assert.deepEqual(
      railAccordionPlan(panels, owner),
      { collapse: [], unmark: [], release: [] },
      `owner ${String(owner)} must not own the rails`,
    );
  }
});

test('releasing reopens exactly the windows the accordion closed', () => {
  const make = fakeDocument().make;
  const panels = [
    panel(make, 'data-panel'),
    panel(make, 'scene-panel', { collapsed: true, marked: true }),
    panel(make, 'cctv-panel', { collapsed: true }),
  ];
  assert.deepEqual(railAccordionReleasePlan(panels), {
    collapse: [],
    unmark: [],
    release: ['scene-panel'],
  });
});

test('the applier writes the marker and the collapse together', () => {
  const doc = fakeDocument();
  doc.panels['data-panel'] = panel(doc.make, 'data-panel').element;
  doc.panels['scene-panel'] = panel(doc.make, 'scene-panel').element;
  const plan = applyRailAccordion({
    ownerId: 'data-panel',
    documentRef: doc,
  });
  assert.deepEqual(plan.collapse, ['scene-panel']);
  assert.deepEqual(
    [...doc.panels['scene-panel'].classes],
    ['collapsed', RAIL_ACCORDION_CLASS],
  );
  assert.deepEqual(
    [...doc.panels['data-panel'].classes],
    [],
    'the window the operator opened carries no marker',
  );
});

test('a layout where the rule does not apply reopens what it closed', () => {
  const doc = fakeDocument();
  const scene = panel(doc.make, 'scene-panel', {
    collapsed: true,
    marked: true,
  });
  const cctv = panel(doc.make, 'cctv-panel', { collapsed: true });
  doc.panels['scene-panel'] = scene.element;
  doc.panels['cctv-panel'] = cctv.element;
  const plan = applyRailAccordion({
    ownerId: null,
    enabled: false,
    documentRef: doc,
  });
  assert.deepEqual(plan.release, ['scene-panel']);
  assert.deepEqual([...scene.element.classes], []);
  assert.deepEqual(
    [...cctv.element.classes],
    ['collapsed'],
    "the operator's own collapse is never reopened",
  );
});

test('a document missing the windows is not an error', () => {
  assert.deepEqual(readRailPanels(null), []);
  assert.deepEqual(readRailPanels({}), []);
  assert.deepEqual(
    applyRailAccordion({ documentRef: { getElementById: () => null } }),
    { collapse: [], unmark: [], release: [] },
  );
});
