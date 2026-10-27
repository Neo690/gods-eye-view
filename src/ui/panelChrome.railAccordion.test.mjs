import test from 'node:test';
import assert from 'node:assert/strict';

import { PanelChrome } from './panelChrome.js';
import { RAIL_ACCORDION_CLASS } from './panelRailAccordion.js';

/**
 * A panel chrome stripped to the rails: the real `setPanelCollapsed`, the real
 * accordion, and stubs for the layout work that needs a browser.
 */
function fixture({ wide = true, cockpit = false } = {}) {
  const nodes = new Map();
  const node = (id, { collapsed = true } = {}) => {
    const classes = new Set(collapsed ? ['collapsed'] : []);
    const value = {
      id,
      hidden: false,
      className: '',
      children: [],
      dataset: {},
      style: { setProperty() {}, removeProperty() {} },
      matches: (selector) => selector.includes('[data-panel-id]'),
      contains: (target) => target === value,
      querySelector: () => null,
      querySelectorAll: () => [],
      setAttribute() {},
      getBoundingClientRect: () => ({
        width: 100,
        height: 100,
        top: 0,
        left: 0,
      }),
      classList: {
        contains: (name) => classes.has(name),
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      },
      classes,
    };
    nodes.set(id, value);
    return value;
  };
  for (const id of [
    'data-panel',
    'scene-panel',
    'pp-toggles',
    'cctv-panel',
    'street-level-panel',
    'global-context-panel',
  ])
    node(id);
  const rail = node('rail', { collapsed: false });
  const leftStack = node('left-panel-stack', { collapsed: false });
  const doc = {
    body: { classList: { contains: () => false, add() {}, remove() {} } },
    documentElement: { dataset: { uiTheme: 'tactical' } },
    getElementById: (id) => nodes.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const priorDoc = globalThis.document;
  const priorWindow = globalThis.window;
  globalThis.document = doc;
  globalThis.window = {
    matchMedia: () => ({
      matches: wide,
      addEventListener() {},
      removeEventListener() {},
    }),
  };

  const saved = [];
  const owner = {
    _rightPanelStack: rail,
    _leftPanelStack: leftStack,
    _panelLayout: {},
    _lifetime: { frame() {} },
    cockpitView: {
      active: cockpit,
      contextCollapsed: false,
      setContextCollapsed() {},
      setSignalCollapsed() {},
    },
    _syncPanelCollapseButton() {},
    _scheduleRightPanelLayout() {},
    _scheduleLeftPanelLayout() {},
    _layoutRightPanels() {},
    _syncCctvPanelViewport() {},
    _cancelMapSourceFocus() {},
    _savePanelCollapsedState: (...args) => saved.push(args),
    shareLinkManager: { claimRestoreLane() {}, onPanelStateChange() {} },
  };
  for (const method of [
    'setPanelCollapsed',
    '_applyRailAccordion',
    '_releaseRailAccordion',
    '_railAccordionApplies',
    '_railAccordionOwnerForLayout',
    'enterCockpit',
    'exitCockpit',
  ])
    owner[method] = PanelChrome.prototype[method].bind(owner);

  return {
    owner,
    saved,
    nodes,
    restore() {
      globalThis.document = priorDoc;
      globalThis.window = priorWindow;
    },
  };
}

const isCollapsed = (f, id) => f.nodes.get(id).classList.contains('collapsed');
const isMarked = (f, id) =>
  f.nodes.get(id).classList.contains(RAIL_ACCORDION_CLASS);

test('opening a window from the drawer closes its siblings', () => {
  const f = fixture();
  try {
    f.owner.setPanelCollapsed('global-context-panel', false);
    f.owner.setPanelCollapsed('data-panel', false, { explicit: true });
    assert.equal(isCollapsed(f, 'global-context-panel'), true);
    assert.equal(isMarked(f, 'global-context-panel'), true);
    assert.equal(isCollapsed(f, 'data-panel'), false);
    assert.equal(isMarked(f, 'data-panel'), false);
    assert.deepEqual(
      f.saved.filter(([, collapsed]) => collapsed === true),
      [],
      'a window the accordion closed is not the operator’s preference to save',
    );
  } finally {
    f.restore();
  }
});

test('a restored layout is left alone, however many windows it holds', () => {
  const f = fixture();
  try {
    f.owner.setPanelCollapsed('data-panel', false, { explicit: true });
    f.owner.setPanelCollapsed('cctv-panel', false, { restore: true });
    assert.equal(isCollapsed(f, 'data-panel'), false);
    assert.equal(isCollapsed(f, 'cctv-panel'), false);
  } finally {
    f.restore();
  }
});

test('a phone layout keeps the phone rule and releases the desktop one', () => {
  const f = fixture({ wide: false });
  try {
    f.nodes.get('scene-panel').classList.remove('collapsed');
    f.owner.setPanelCollapsed('data-panel', false, { explicit: true });
    assert.equal(
      isCollapsed(f, 'scene-panel'),
      false,
      'the desktop rule must not touch a phone layout',
    );
    f.nodes.get('scene-panel').classList.add('collapsed', RAIL_ACCORDION_CLASS);
    f.owner._applyRailAccordion(null);
    assert.equal(isMarked(f, 'scene-panel'), false);
    assert.equal(isCollapsed(f, 'scene-panel'), false);
  } finally {
    f.restore();
  }
});

test('Cockpit releases the rule and puts it back on the way out', () => {
  const f = fixture();
  try {
    f.owner.setPanelCollapsed('data-panel', false, { explicit: true });
    f.owner.setPanelCollapsed('cctv-panel', false, { explicit: true });
    assert.equal(isCollapsed(f, 'data-panel'), true);
    assert.equal(isMarked(f, 'data-panel'), true);

    f.owner.cockpitView.active = true;
    f.owner.enterCockpit();
    assert.equal(
      isMarked(f, 'data-panel'),
      false,
      'the rule releases before Cockpit clears the map-view panels',
    );
    assert.equal(
      isCollapsed(f, 'data-panel'),
      true,
      'Cockpit clears the map-view panels itself',
    );

    f.owner.cockpitView.active = false;
    f.owner.exitCockpit();
    assert.equal(
      isCollapsed(f, 'data-panel'),
      false,
      'Cockpit remembers the operator’s layout, not the windows the rule closed',
    );
    assert.equal(
      isCollapsed(f, 'cctv-panel'),
      true,
      'and the map view is still one window at a time',
    );
    assert.equal(isMarked(f, 'cctv-panel'), true);
    const open = [...f.nodes.keys()].filter(
      (id) => id !== 'rail' && id !== 'left-panel-stack' && !isCollapsed(f, id),
    );
    assert.deepEqual(open, ['data-panel']);
  } finally {
    f.restore();
  }
});
