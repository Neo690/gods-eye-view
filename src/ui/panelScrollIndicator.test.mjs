import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PANEL_SCROLL_BODY_SELECTOR,
  PANEL_SCROLL_MEDIA,
  PANEL_SCROLL_SHEET_SELECTOR,
  createPanelScrollIndicators,
} from './panelScrollIndicator.js';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/** Styles that keep what they are given, so the geometry can follow them. */
function fakeStyle(owner) {
  const props = new Map();
  return {
    setProperty(name, value) {
      props.set(name, String(value));
      if (name === 'height' && owner) owner.height = parseFloat(value) || 0;
    },
    getPropertyValue(name) {
      return props.get(name) ?? '';
    },
  };
}

function fakeElement(kind) {
  const listeners = new Map();
  const el = {
    kind,
    className: '',
    hidden: false,
    dataset: {},
    children: [],
    parent: null,
    height: 0,
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    setAttribute() {},
    append(child) {
      child.parent = el;
      el.children.push(child);
    },
    remove() {
      if (!el.parent) return;
      el.parent.children = el.parent.children.filter((node) => node !== el);
      el.parent = null;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    listeners,
  };
  el.style = fakeStyle(el);
  return el;
}

/**
 * One rail sheet. `trackHeight` is the height the stylesheet gives the bar
 * (sheet minus header), which the fake bar reports once it is positioned.
 */
function fakeSheet({ collapsed = false, clientHeight = 200, scrollHeight = 1000, trackHeight = 200 } = {}) {
  const sheet = fakeElement('sheet');
  sheet.id = 'data-panel';
  const classes = new Set(
    collapsed ? ['panel-collapsible', 'collapsed'] : ['panel-collapsible'],
  );
  sheet.classList = {
    contains: (name) => classes.has(name),
    add: (name) => classes.add(name),
    remove: (name) => classes.delete(name),
  };
  sheet.clientHeight = trackHeight;
  sheet.getBoundingClientRect = () => ({
    top: 54,
    bottom: 54 + trackHeight + 42,
    height: trackHeight + 42,
  });
  const body = fakeElement('body');
  body.clientHeight = clientHeight;
  body.scrollHeight = scrollHeight;
  body.getBoundingClientRect = () => ({
    top: 54 + 42,
    bottom: 54 + 42 + trackHeight,
    height: trackHeight,
  });
  sheet.body = body;
  sheet.trackHeight = trackHeight;
  sheet.querySelector = (selector) =>
    selector === PANEL_SCROLL_BODY_SELECTOR ? body : null;
  return sheet;
}

function fakeDocument(sheets, { mobile = true } = {}) {
  const listeners = new Map();
  return {
    querySelectorAll: () => sheets,
    getElementById: () => null,
    createElement: () => {
      const el = fakeElement('created');
      // The sheet's own height is the fallback track; a created bar starts at
      // zero until the stylesheet positions it, exactly as in the browser.
      el.getBoundingClientRect = () => ({
        top: 96,
        height: el.height || 200,
        bottom: 96 + (el.height || 200),
      });
      return el;
    },
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

const barOf = (sheet) =>
  sheet.children.find((child) => child.className === 'gev-scroll-indicator');
const thumbOf = (sheet) =>
  barOf(sheet)?.children.find((child) => child.className === 'gev-scroll-thumb');

test('the bar is for the rail sheets and the phone breakpoint', () => {
  assert.equal(PANEL_SCROLL_MEDIA, '(max-width: 720px)');
  assert.match(PANEL_SCROLL_SHEET_SELECTOR, /#left-panel-stack > \.panel-collapsible/);
  assert.match(PANEL_SCROLL_SHEET_SELECTOR, /#right-context-rail > \.panel-collapsible/);
  assert.equal(
    PANEL_SCROLL_BODY_SELECTOR,
    '[data-rail-scroller], .data-toggle-list, .pp-panel-body',
  );
});

test('the stylesheet draws the track and the thumb', () => {
  const css = readStylesheet(path.join(ROOT, 'src/ui/styles/mobile-compact.css'));
  assert.match(css, /\.gev-scroll-indicator\s*\{[\s\S]{0,400}?position:\s*absolute;/);
  assert.match(css, /\.gev-scroll-thumb\s*\{[\s\S]{0,400}?touch-action:\s*none;/);
  assert.match(css, /\.gev-scroll-indicator\[hidden\]\s*\{\s*display:\s*none;/);
});

test('without a sheet there is no bar', () => {
  assert.equal(createPanelScrollIndicators({ document: null }), null);
  assert.equal(
    createPanelScrollIndicators({ document: { querySelectorAll: () => [] } }),
    null,
  );
});

test('an open overflowing sheet gets a bar sized from its content', () => {
  const sheet = fakeSheet();
  const control = createPanelScrollIndicators({
    document: fakeDocument([sheet]),
  });
  assert.ok(control);
  const bar = barOf(sheet);
  assert.ok(bar, 'the bar is appended to the sheet');
  assert.equal(bar.hidden, false);
  // 200 of 1000 visible over a 200px track: a fifth of it.
  const thumb = thumbOf(sheet);
  assert.equal(thumb.style.getPropertyValue('height'), '40px');
  assert.equal(thumb.style.getPropertyValue('top'), '0px');
  control.destroy();
});

test('the thumb follows the list and stops at the end of the track', () => {
  const sheet = fakeSheet();
  const control = createPanelScrollIndicators({
    document: fakeDocument([sheet]),
  });
  const thumb = thumbOf(sheet);
  sheet.body.scrollTop = 800; // the whole range: 1000 - 200
  control.sync();
  assert.equal(thumb.style.getPropertyValue('top'), '160px');
  sheet.body.scrollTop = 400;
  control.sync();
  assert.equal(thumb.style.getPropertyValue('top'), '80px', 'halfway down');
  control.destroy();
});

test('a tall list gets a thumb that never shrinks to a dot', () => {
  const sheet = fakeSheet({ clientHeight: 150, scrollHeight: 12000 });
  const control = createPanelScrollIndicators({
    document: fakeDocument([sheet]),
  });
  const thumb = thumbOf(sheet);
  const height = parseFloat(thumb.style.getPropertyValue('height'));
  assert.ok(height >= 26 && height < 40, `expected a 26px floor, got ${height}`);
  control.destroy();
});

test('a list that fits gets no bar at all', () => {
  const sheet = fakeSheet({ scrollHeight: 180, clientHeight: 200 });
  const control = createPanelScrollIndicators({
    document: fakeDocument([sheet]),
  });
  assert.equal(barOf(sheet).hidden, true);
  control.destroy();
});

test('a collapsed sheet, and a desktop, keep the bar away', () => {
  const collapsed = fakeSheet({ collapsed: true });
  const control = createPanelScrollIndicators({
    document: fakeDocument([collapsed]),
  });
  assert.equal(barOf(collapsed).hidden, true);
  control.destroy();

  const wide = fakeSheet();
  const desktop = createPanelScrollIndicators({
    document: fakeDocument([wide], { mobile: false }),
  });
  assert.equal(barOf(wide).hidden, true, 'the native scrollbar is real there');
  desktop.destroy();
});

test('a sheet without a scroller is left alone', () => {
  const sheet = fakeSheet();
  sheet.querySelector = () => null;
  const control = createPanelScrollIndicators({
    document: fakeDocument([sheet]),
  });
  assert.equal(control.entries.length, 0);
  assert.equal(barOf(sheet), undefined);
  control.destroy();
});

test('dragging the thumb scrolls the list', () => {
  const sheet = fakeSheet();
  const doc = fakeDocument([sheet]);
  const control = createPanelScrollIndicators({ document: doc });
  const bar = barOf(sheet);
  const thumb = thumbOf(sheet);
  thumb.listeners.get('pointerdown')({
    currentTarget: thumb,
    clientY: 96,
    pointerId: 1,
    preventDefault() {},
  });
  assert.equal(bar.dataset.dragging, 'true', 'the bar shows it is being held');
  doc.listeners.get('pointermove')({
    clientY: 96 + 100,
    preventDefault() {},
  });
  // 100px past the top of a 160px usable track (200 track, 40 thumb), over a
  // scroll range of 800px: five eighths of the list.
  assert.equal(Math.round(sheet.body.scrollTop), 500);
  doc.listeners.get('pointerup')({});
  assert.equal(bar.dataset.dragging, undefined);
  control.destroy();
});

test('destroying the bar takes it out of the sheet and lets go of the list', () => {
  const sheet = fakeSheet();
  const control = createPanelScrollIndicators({
    document: fakeDocument([sheet]),
  });
  control.destroy();
  assert.equal(barOf(sheet), undefined);
  assert.equal(sheet.body.listeners.size, 0);
  assert.equal(sheet.listeners.size, 0);
});
