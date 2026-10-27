import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PANEL_SHEET_HANDLE_SELECTOR,
  PANEL_SHEET_RAILS,
  PANEL_SWIPE_MEDIA,
  createPanelSwipeDismiss,
} from './panelSwipeDismiss.js';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function fakeStyle() {
  const props = new Map();
  return {
    setProperty(name, value) {
      props.set(name, String(value));
    },
    getPropertyValue(name) {
      return props.get(name) ?? '';
    },
  };
}

/** One sheet, as a direct child of its rail, with a header that is its own. */
function fakeSheet(id, { collapsed = false, height = 300, parent = null } = {}) {
  const classes = new Set(
    collapsed ? ['panel-collapsible', 'collapsed'] : ['panel-collapsible'],
  );
  const el = {
    id,
    style: fakeStyle(),
    dataset: {},
    parentElement: parent,
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
    },
    getBoundingClientRect: () => ({ width: 344, height }),
    classes,
  };
  const header = {
    closest: (selector) =>
      selector === '.panel-collapsible'
        ? el
        : selector === PANEL_SHEET_HANDLE_SELECTOR
          ? header
          : null,
  };
  el.header = header;
  return el;
}

/** A rail that answers touches on behalf of its children. */
function fakeRail(id) {
  const listeners = new Map();
  const rail = {
    id,
    children: [],
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    emit(type, event = {}) {
      listeners.get(type)?.({ currentTarget: rail, ...event });
    },
    append(sheet) {
      sheet.parentElement = rail;
      rail.children.push(sheet);
      return sheet;
    },
    listeners,
  };
  return rail;
}

function fakeDocument(rails, { mobile = true } = {}) {
  const listeners = new Map();
  return {
    getElementById: (id) => rails.find((rail) => rail.id === id) ?? null,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    defaultView: { matchMedia: () => ({ matches: mobile }) },
    listeners,
  };
}

const drawOf = (sheet) => sheet.style.getPropertyValue('--sheet-draw');

/** A clock the tests advance by hand, so a flick is a flick and a pull is not. */
function fakeClock(start = 1000) {
  let value = start;
  return { now: () => value, advance: (ms) => (value += ms) };
}

/** Press the header, hold for `ms`, move to `to`, release there. */
function drag(doc, rail, sheet, from, to, clock, ms = 0) {
  rail.emit('pointerdown', {
    target: sheet.header,
    clientY: from,
    pointerType: 'touch',
    button: 0,
  });
  clock?.advance(ms);
  doc.listeners.get('pointermove')({ clientY: to, preventDefault() {} });
  doc.listeners.get('pointerup')({ clientY: to });
}

/** Both rails, each with the sheets under test. */
function setup(sheetsByRail, options) {
  const left = fakeRail('left-panel-stack');
  const right = fakeRail('right-context-rail');
  for (const sheet of sheetsByRail.left ?? []) left.append(sheet);
  for (const sheet of sheetsByRail.right ?? []) right.append(sheet);
  return { doc: fakeDocument([left, right], options), left, right };
}

test('the gesture lives on the two rails, not on one panel list', () => {
  assert.equal(PANEL_SWIPE_MEDIA, '(max-width: 720px)');
  assert.deepEqual([...PANEL_SHEET_RAILS], ['left-panel-stack', 'right-context-rail']);
  assert.equal(PANEL_SHEET_HANDLE_SELECTOR, '.panel-header, .pp-header-row');
});

test('the stylesheet carries the transform the gesture writes', () => {
  const css = readStylesheet(path.join(ROOT, 'src/ui/styles/mobile-compact.css'));
  assert.match(css, /transform:\s*translateY\(var\(--sheet-draw, 0px\)\)/);
  assert.match(css, /transition:\s*transform 170ms/);
  assert.match(
    css,
    /\.panel-collapsible\[data-sheet-dragging='true'\]/,
    'a dragging sheet has to drop the settle transition',
  );
  assert.match(
    css,
    /\.panel-collapsible:not\(\.collapsed\)[\s\S]{0,600}?\.panel-header,[\s\S]{0,600}?touch-action:\s*none;/,
    'the header needs to own the vertical axis',
  );
});

test('without a rail, or without a way to close a sheet, there is nothing to swipe', () => {
  assert.equal(createPanelSwipeDismiss({ document: null }), null);
  assert.equal(
    createPanelSwipeDismiss({ document: { getElementById: () => null } }),
    null,
  );
  assert.equal(
    createPanelSwipeDismiss({
      document: { getElementById: () => ({}) },
    }),
    null,
  );
});

test('a downward drag follows the finger and closes the sheet', () => {
  const sheet = fakeSheet('data-panel');
  const { doc, left } = setup({ left: [sheet] });
  const calls = [];
  const control = createPanelSwipeDismiss({
    document: doc,
    setPanelCollapsed: (id, collapsed, options) =>
      calls.push({ id, collapsed, options }),
  });
  assert.ok(control);

  left.emit('pointerdown', {
    target: sheet.header,
    clientY: 80,
    pointerType: 'touch',
    button: 0,
  });
  doc.listeners.get('pointermove')({ clientY: 170, preventDefault() {} });
  assert.equal(drawOf(sheet), '90px', 'the sheet tracks the finger');
  assert.equal(sheet.dataset.sheetDragging, 'true');

  doc.listeners.get('pointerup')({ clientY: 170 });
  assert.equal(drawOf(sheet), '0px', 'the offset is handed back to the layout');
  assert.equal(sheet.dataset.sheetDragging, undefined);
  assert.deepEqual(
    calls.map(({ id, collapsed }) => [id, collapsed]),
    [['data-panel', true]],
  );
  assert.deepEqual(calls[0].options, { explicit: true });
  control.destroy();
});

test('a short, slow pull settles back and leaves the sheet open', () => {
  const sheet = fakeSheet('pp-toggles', { height: 400 });
  const { doc, right } = setup({ right: [sheet] });
  const clock = fakeClock();
  const calls = [];
  const control = createPanelSwipeDismiss({
    document: doc,
    setPanelCollapsed: (...args) => calls.push(args),
    now: clock.now,
  });
  drag(doc, right, sheet, 80, 120, clock, 400);
  assert.equal(drawOf(sheet), '0px');
  assert.deepEqual(calls, [], '40px is neither far enough nor fast enough');
  control.destroy();
});

test('a quick flick dismisses even when the pull is short', () => {
  const sheet = fakeSheet('cctv-panel', { height: 600 });
  const { doc, right } = setup({ right: [sheet] });
  const clock = fakeClock();
  const calls = [];
  const control = createPanelSwipeDismiss({
    document: doc,
    setPanelCollapsed: (...args) => calls.push(args),
    now: clock.now,
  });
  drag(doc, right, sheet, 100, 140, clock, 20);
  assert.deepEqual(calls, [['cctv-panel', true, { explicit: true }]]);
  control.destroy();
});

test('an upward drag is left alone — the content keeps its scroll axis', () => {
  const sheet = fakeSheet('scene-panel');
  const { doc, left } = setup({ left: [sheet] });
  const clock = fakeClock();
  const calls = [];
  const control = createPanelSwipeDismiss({
    document: doc,
    setPanelCollapsed: (...args) => calls.push(args),
    now: clock.now,
  });
  drag(doc, left, sheet, 200, 120, clock, 300);
  assert.equal(drawOf(sheet), '', 'the sheet is never touched');
  assert.equal(sheet.dataset.sheetDragging, undefined);
  assert.deepEqual(calls, []);
  control.destroy();
});

test('a touch on the body is not a sheet drag', () => {
  const sheet = fakeSheet('data-panel');
  const { doc, left } = setup({ left: [sheet] });
  const calls = [];
  const control = createPanelSwipeDismiss({
    document: doc,
    setPanelCollapsed: (...args) => calls.push(args),
  });
  left.emit('pointerdown', {
    target: { closest: () => null },
    clientY: 80,
    pointerType: 'touch',
    button: 0,
  });
  doc.listeners.get('pointermove')({ clientY: 260, preventDefault() {} });
  doc.listeners.get('pointerup')({ clientY: 260 });
  assert.equal(drawOf(sheet), '', 'the body scrolls, the sheet does not move');
  assert.deepEqual(calls, []);
  control.destroy();
});

test('a header nested in an inner section moves nothing', () => {
  const context = fakeSheet('global-context-panel');
  const { doc, right } = setup({ right: [context] });
  const calls = [];
  const control = createPanelSwipeDismiss({
    document: doc,
    setPanelCollapsed: (...args) => calls.push(args),
  });
  // Context owns the Radio section: its header belongs to that section, not to
  // the sheet, so pulling it must not slide the whole Context window away.
  const radio = { id: 'radio-panel' };
  context.children = [radio];
  const radioHeader = {
    closest: (selector) =>
      selector === '.panel-collapsible'
        ? radio
        : selector === PANEL_SHEET_HANDLE_SELECTOR
          ? radioHeader
          : null,
  };
  right.emit('pointerdown', {
    target: radioHeader,
    clientY: 80,
    pointerType: 'touch',
    button: 0,
  });
  doc.listeners.get('pointermove')({ clientY: 260, preventDefault() {} });
  doc.listeners.get('pointerup')({ clientY: 260 });
  assert.equal(drawOf(context), '');
  assert.deepEqual(calls, []);
  control.destroy();
});

test('a section nested inside a sheet is not a sheet itself', () => {
  const context = fakeSheet('global-context-panel');
  const { doc, right } = setup({ right: [context] });
  const calls = [];
  const control = createPanelSwipeDismiss({
    document: doc,
    setPanelCollapsed: (...args) => calls.push(args),
  });
  // A nested collapsible is not a direct child of the rail, so only the sheet
  // around it may be swiped; its own header cannot start a second gesture.
  const nested = fakeSheet('radio-panel');
  nested.parentElement = context;
  right.emit('pointerdown', {
    target: nested.header,
    clientY: 80,
    pointerType: 'touch',
    button: 0,
  });
  doc.listeners.get('pointermove')({ clientY: 280, preventDefault() {} });
  doc.listeners.get('pointerup')({ clientY: 280 });
  assert.equal(drawOf(context), '');
  assert.deepEqual(calls, []);
  control.destroy();
});

test('a collapsed sheet and a desktop are both inert', () => {
  const collapsed = fakeSheet('data-panel', { collapsed: true });
  const { doc, left } = setup({ left: [collapsed] });
  const calls = [];
  const control = createPanelSwipeDismiss({
    document: doc,
    setPanelCollapsed: (...args) => calls.push(args),
  });
  drag(doc, left, collapsed, 80, 260);
  assert.deepEqual(calls, []);
  control.destroy();

  const wide = fakeSheet('data-panel');
  const desktop = setup({ left: [wide] }, { mobile: false });
  const desktopCalls = [];
  const desktopControl = createPanelSwipeDismiss({
    document: desktop.doc,
    setPanelCollapsed: (...args) => desktopCalls.push(args),
  });
  drag(desktop.doc, desktop.left, wide, 80, 300);
  assert.deepEqual(desktopCalls, [], 'the rails are not sheets at that width');
  desktopControl.destroy();
});

test('a panel that moved into the rail later is covered too', () => {
  const { doc, right } = setup({ right: [] });
  const calls = [];
  const control = createPanelSwipeDismiss({
    document: doc,
    setPanelCollapsed: (...args) => calls.push(args),
  });
  const late = right.append(fakeSheet('pp-toggles', { height: 200 }));
  drag(doc, right, late, 80, 220);
  assert.deepEqual(calls, [['pp-toggles', true, { explicit: true }]]);
  control.destroy();
});

test('the click a drag ends on does not reopen the sheet', () => {
  const sheet = fakeSheet('data-panel');
  const { doc, left } = setup({ left: [sheet] });
  const control = createPanelSwipeDismiss({
    document: doc,
    setPanelCollapsed: () => {},
  });
  drag(doc, left, sheet, 80, 200);

  let prevented = 0;
  let stopped = 0;
  left.listeners.get('click')({
    preventDefault: () => (prevented += 1),
    stopPropagation: () => (stopped += 1),
  });
  assert.equal(prevented, 1, 'the collapse button never sees the drag');
  assert.equal(stopped, 1);
  control.destroy();
});

test('a drag that never happened does not swallow a later click', () => {
  const sheet = fakeSheet('data-panel');
  const { doc, left } = setup({ left: [sheet] });
  const control = createPanelSwipeDismiss({
    document: doc,
    setPanelCollapsed: () => {},
  });
  left.emit('pointerdown', {
    target: sheet.header,
    clientY: 80,
    pointerType: 'touch',
    button: 0,
  });
  doc.listeners.get('pointerup')({ clientY: 80 });
  let prevented = 0;
  left.listeners.get('click')({
    preventDefault: () => (prevented += 1),
    stopPropagation: () => {},
  });
  assert.equal(prevented, 0, 'a tap on the header is still a tap');
  control.destroy();
});

test('destroying the gesture lets go of every listener', () => {
  const sheet = fakeSheet('data-panel');
  const { doc, left } = setup({ left: [sheet] });
  const control = createPanelSwipeDismiss({
    document: doc,
    setPanelCollapsed: () => {},
  });
  control.destroy();
  assert.equal(left.listeners.size, 0);
  assert.equal(doc.listeners.size, 0);
  assert.equal(drawOf(sheet), '0px');
});
