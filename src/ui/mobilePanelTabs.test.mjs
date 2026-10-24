import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MOBILE_PANEL_TAB_MEDIA,
  MOBILE_PANEL_TAB_SPECS,
  createMobilePanelTabs,
} from './mobilePanelTabs.js';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const TEMPLATES = ['layer-panels.html', 'display-controls.html', 'context.html'];

function readTemplates() {
  return TEMPLATES.map((name) =>
    readFileSync(path.join(ROOT, 'src/ui/templates', name), 'utf8'),
  ).join('\n');
}

/** Just enough document for the disclosure: elements, panels, and listeners. */
function fakeDocument({ panels = {}, mobile = true, actionRow = null } = {}) {
  const listeners = new Map();
  const elements = new Map();
  const make = (tag) => {
    const classes = new Set();
    const node = {
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      dataset: {},
      hidden: false,
      textContent: '',
      title: '',
      children: [],
      attributes: new Map(),
      classList: {
        contains: (name) => classes.has(name),
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        toggle: (name, force) => {
          const next = force === undefined ? !classes.has(name) : force;
          if (next) classes.add(name);
          else classes.delete(name);
          return next;
        },
      },
      append(...nodes) {
        this.children.push(...nodes);
      },
      prepend(...nodes) {
        this.children.unshift(...nodes);
        for (const node of nodes) node.parentNode = this;
      },
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      },
      getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
      },
      addEventListener(type, handler) {
        this.listeners ??= new Map();
        this.listeners.set(type, handler);
      },
      removeEventListener(type) {
        this.listeners?.delete(type);
      },
      closest() {
        return null;
      },
      remove() {},
      focus() {
        this.focused = true;
      },
      listeners: new Map(),
    };
    return node;
  };
  const doc = {
    body: make('body'),
    createElement: make,
    getElementById: (id) =>
      panels[id] ?? (actionRow && actionRow.id === id ? actionRow : null),
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    defaultView: { matchMedia: () => ({ matches: mobile }) },
    listeners,
    created: elements,
  };
  return { doc, make, listeners };
}

function panel(make, id, { collapsed = true } = {}) {
  const node = make('section');
  node.id = id;
  node.classList.toggle('collapsed', collapsed);
  return node;
}

test('the disclosure lists the six rail windows in reading order', () => {
  assert.deepEqual(
    MOBILE_PANEL_TAB_SPECS.map((spec) => spec.id),
    [
      'data-panel',
      'scene-panel',
      'pp-toggles',
      'cctv-panel',
      'street-level-panel',
      'global-context-panel',
    ],
  );
  assert.equal(MOBILE_PANEL_TAB_MEDIA, '(max-width: 720px)');
});

test('every window id is a real panel in the markup', () => {
  const markup = readTemplates();
  for (const spec of MOBILE_PANEL_TAB_SPECS)
    assert.match(
      markup,
      new RegExp(`id="${spec.id}"`),
      `${spec.id} has no element: a renamed panel would silently drop its entry`,
    );
});

test('the windows are behind a closed control, not laid over the map', () => {
  const css = readStylesheet(
    path.join(ROOT, 'src/ui/styles/mobile-compact.css'),
  );
  // Hidden everywhere above the breakpoint, or the button renders under the globe.
  assert.match(css, /\.gev-panel-tabs\s*\{\s*display:\s*none;/);
  // The toggle is a flex item of the globe action row, not a floating button
  // under it; `relative` is only what the list hangs from.
  assert.match(
    css,
    /@media \(max-width: 720px\)[\s\S]*\.gev-panel-tabs\s*\{\s*position:\s*relative;/,
  );
  // The list is a popover: one column, hidden until asked for.
  assert.match(
    css,
    /@media \(max-width: 720px\)[\s\S]*\.gev-panel-tabs-menu\[hidden\]\s*\{\s*display:\s*none;/,
  );
  assert.doesNotMatch(css, /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  // The collapsed chips the strip replaces must not keep drawing.
  assert.match(
    css,
    /#left-panel-stack > \.panel-collapsible\.collapsed[\s\S]{0,400}?display:\s*none;/,
  );
  // Every window is a sheet that starts directly under the action row
  // (10 + 34 + 10) and stops above the zoom cluster. Street Level is in the
  // same list: left out, it opened at the rail's own top, on a different line
  // from its five siblings.
  assert.match(
    css,
    /#right-context-rail > #street-level-panel:not\(\.collapsed\),[\s\S]{0,600}?top:\s*54px;/,
  );
  assert.match(
    css,
    /#right-context-rail > #global-context-panel:not\(\.collapsed\)[\s\S]{0,900}?max-height:\s*calc\(100dvh - 409px\);/,
  );
  // The list has to paint over a sheet whose rail sits at 240.
  assert.match(
    css,
    /#top-center-actions\.panel-tabs-open\s*\{\s*z-index:\s*260;/,
  );
});

test('the toggle rides the globe action row when there is one', () => {
  const panels = {};
  const { doc, make } = fakeDocument({ panels });
  panels['data-panel'] = panel(make, 'data-panel');
  // The row is where the flag lives, so the button has to lead it.
  const row = make('nav');
  row.id = 'top-center-actions';
  const findById = doc.getElementById;
  doc.getElementById = (id) => (id === row.id ? row : findById(id));
  const control = createMobilePanelTabs({
    document: doc,
    setPanelCollapsed: () => {},
  });
  assert.equal(row.children[0], control.element, 'the button comes first in the row');
  assert.equal(control.element.parentNode, row);
  control.destroy();
});

test('without a document there is nothing to build', () => {
  assert.equal(createMobilePanelTabs({ document: null }), null);
  assert.equal(
    createMobilePanelTabs({ document: { body: {}, getElementById: () => null } }),
    null,
  );
});

test('the list starts closed and the button says so', () => {
  const panels = {};
  const { doc, make } = fakeDocument({ panels });
  panels['data-panel'] = panel(make, 'data-panel');
  const control = createMobilePanelTabs({ document: doc, setPanelCollapsed: () => {} });
  assert.ok(control);
  const menu = control.element.children.find((c) => c.id === 'gev-panel-tabs-menu');
  const toggle = control.element.children.find((c) =>
    c.className.includes('gev-panel-tabs-toggle'),
  );
  assert.equal(menu.hidden, true, 'the list must not cover the map by default');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  control.destroy();
});

test('choosing a window opens it, closes the previous one, and puts the list away', () => {
  const panels = {};
  const { doc, make } = fakeDocument({ panels });
  panels['data-panel'] = panel(make, 'data-panel', { collapsed: false });
  panels['scene-panel'] = panel(make, 'scene-panel');
  const calls = [];
  const control = createMobilePanelTabs({
    document: doc,
    setPanelCollapsed: (id, collapsed, options) => calls.push({ id, collapsed, options }),
    isMobile: () => true,
  });
  const toggle = control.element.children.find((c) =>
    c.className.includes('gev-panel-tabs-toggle'),
  );
  const handler = control.element.listeners.get('click');

  const click = (target) => handler({ target });
  const toggleTarget = { closest: (selector) => (selector.includes('toggle') ? toggle : null) };
  click(toggleTarget);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');

  const item = {
    closest: (selector) =>
      selector.includes('toggle') ? null : { dataset: { panelTab: 'scene-panel' } },
  };
  click(item);

  assert.deepEqual(
    calls.map(({ id, collapsed }) => [id, collapsed]),
    [
      ['data-panel', true],
      ['scene-panel', false],
    ],
    'one window at a time: the open one closes before the chosen one opens',
  );
  assert.equal(
    toggle.getAttribute('aria-expanded'),
    'false',
    'the list closes once a window is chosen',
  );
  control.destroy();
});
