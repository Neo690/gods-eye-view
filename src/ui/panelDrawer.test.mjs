import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PANEL_DRAWER_MEDIA, createPanelDrawer } from './panelDrawer.js';
import { PANEL_WINDOW_SPECS } from './panelWindows.js';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const TEMPLATES = [
  'layer-panels.html',
  'display-controls.html',
  'context.html',
];

function readTemplates() {
  return TEMPLATES.map((name) =>
    readFileSync(path.join(ROOT, 'src/ui/templates', name), 'utf8'),
  ).join('\n');
}

/** Just enough document for the drawer: a body, panels and listeners. */
function fakeDocument({ panels = {}, wide = true } = {}) {
  const listeners = new Map();
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
      classes,
      append(...nodes) {
        this.children.push(...nodes);
        for (const node of nodes) node.parentNode = this;
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
      remove() {
        this.removed = true;
      },
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
    getElementById: (id) => panels[id] ?? null,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    defaultView: { matchMedia: () => ({ matches: wide }) },
    listeners,
  };
  return { doc, make };
}

function panel(make, id, { collapsed = true } = {}) {
  const node = make('section');
  node.id = id;
  if (collapsed) node.classList.add('collapsed');
  return node;
}

/** A click target that answers `closest` the way the real DOM would. */
function clickTarget({ tab = null, toggle = null } = {}) {
  return {
    closest: (selector) => {
      if (selector.includes('drawer-toggle')) return toggle;
      if (selector.includes('drawer-tab'))
        return tab ? { dataset: { panelDrawerTab: tab } } : null;
      return null;
    },
  };
}

test('the drawer lists the six rail windows above the phone breakpoint', () => {
  assert.deepEqual(
    PANEL_WINDOW_SPECS.map((spec) => spec.id),
    [
      'data-panel',
      'scene-panel',
      'pp-toggles',
      'cctv-panel',
      'street-level-panel',
      'global-context-panel',
    ],
  );
  assert.equal(PANEL_DRAWER_MEDIA, '(min-width: 721px)');
});

test('every window id is a real panel in the markup', () => {
  const markup = readTemplates();
  for (const spec of PANEL_WINDOW_SPECS)
    assert.match(
      markup,
      new RegExp(`id="${spec.id}"`),
      `${spec.id} has no element: a renamed panel would silently drop its tab`,
    );
});

test('the drawer hides itself on a phone, in Cockpit and in embeds', () => {
  const css = readStylesheet(path.join(ROOT, 'src/ui/styles/panel-drawer.css'));
  // Hidden by default, so a phone never draws it.
  assert.match(css, /\.gev-panel-drawer\s*\{\s*display:\s*none;/);
  // The desktop rule is scoped to the built drawer and to the map view: a
  // Cockpit rail and an embed lay their own panels out.
  assert.match(
    css,
    /@media \(min-width: 721px\)[\s\S]*body\.panel-drawer:not\(\.cockpit-mode\):not\(\.ui-embed\) \.gev-panel-drawer\s*\{\s*position:\s*fixed;/,
  );
  // Docked to the left edge, on the rails' own anchors, so it cannot land on
  // a panel: the rails start at --left-stack-x (52px) and the drawer stops
  // before them.
  assert.match(
    css,
    /body\.panel-drawer:not\(\.cockpit-mode\):not\(\.ui-embed\) \.gev-panel-drawer\s*\{[\s\S]*?left:\s*8px;/,
  );
  // Reading order is vertical, or the labels would be truncated to nothing.
  assert.match(
    css,
    /\.gev-panel-drawer-label\s*\{[\s\S]*?writing-mode:\s*vertical-rl;/,
  );
  // The list can be tucked away, and a hidden list is not drawn.
  assert.match(
    css,
    /\.gev-panel-drawer-list\[hidden\]\s*\{\s*display:\s*none;/,
  );
  // The collapsed chips of both rails are what the drawer replaces.
  assert.match(
    css,
    /body\.panel-drawer:not\(\.cockpit-mode\):not\(\.ui-embed\)\s*#left-panel-stack\s*>\s*\.panel-collapsible\.collapsed,/,
  );
  assert.match(
    css,
    /body\.panel-drawer:not\(\.cockpit-mode\):not\(\.ui-embed\)\s*#right-context-rail\s*>\s*\.panel-collapsible\.collapsed\s*\{\s*display:\s*none;/,
  );
});

test('without a document, or without any window, there is nothing to build', () => {
  assert.equal(
    createPanelDrawer({ document: null, setPanelCollapsed: () => {} }),
    null,
  );
  const { doc } = fakeDocument({ panels: {} });
  assert.equal(
    createPanelDrawer({ document: doc, setPanelCollapsed: () => {} }),
    null,
  );
  assert.equal(
    createPanelDrawer({ document: { body: {}, getElementById: () => null } }),
    null,
    'a caller that forgets setPanelCollapsed gets no half-built drawer',
  );
});

test('the drawer docks itself, marks the layout, and starts with its list open', () => {
  const panels = {};
  const { doc, make } = fakeDocument({ panels });
  panels['data-panel'] = panel(make, 'data-panel', { collapsed: false });
  const control = createPanelDrawer({
    document: doc,
    setPanelCollapsed: () => {},
  });
  assert.ok(control);
  assert.equal(doc.body.classList.contains('panel-drawer'), true);
  assert.equal(control.element.parentNode, doc.body);
  const list = control.element.children.find(
    (child) => child.id === 'gev-panel-drawer-list',
  );
  const toggle = control.element.children.find((child) =>
    child.className.includes('drawer-toggle'),
  );
  assert.equal(list.hidden, false, 'a way in nobody can see is not a way in');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(
    list.children[0].getAttribute('aria-pressed'),
    'true',
    'the open window is the press the operator can see',
  );
  assert.equal(
    [...list.children].length,
    1,
    'a window that is not in the document gets no tab',
  );
  control.destroy();
  assert.equal(
    doc.body.classList.contains('panel-drawer'),
    false,
    'destroying the drawer must not leave the rails relying on it',
  );
  assert.equal(control.element.removed, true);
});

test('choosing a tab toggles that window through the caller', () => {
  const panels = {};
  const { doc, make } = fakeDocument({ panels });
  panels['data-panel'] = panel(make, 'data-panel', { collapsed: false });
  panels['scene-panel'] = panel(make, 'scene-panel');
  const calls = [];
  const control = createPanelDrawer({
    document: doc,
    setPanelCollapsed: (id, collapsed, options) =>
      calls.push({ id, collapsed, options }),
  });
  const handler = control.element.listeners.get('click');

  handler({ target: clickTarget({ tab: 'scene-panel' }) });
  handler({ target: clickTarget({ tab: 'data-panel' }) });

  assert.deepEqual(
    calls.map(({ id, collapsed }) => [id, collapsed]),
    [
      ['scene-panel', false],
      ['data-panel', true],
    ],
    'a closed window opens; the open one closes',
  );
  assert.deepEqual(calls[0].options, { explicit: true });
  control.destroy();
});

test('the toggle tucks the list away and Escape puts it away too', () => {
  const panels = {};
  const { doc, make } = fakeDocument({ panels });
  panels['data-panel'] = panel(make, 'data-panel');
  const control = createPanelDrawer({
    document: doc,
    setPanelCollapsed: () => {},
  });
  const list = control.element.children.find(
    (child) => child.id === 'gev-panel-drawer-list',
  );
  const toggle = control.element.children.find((child) =>
    child.className.includes('drawer-toggle'),
  );
  const onClick = control.element.listeners.get('click');
  onClick({ target: clickTarget({ toggle }) });
  assert.equal(list.hidden, true);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');

  onClick({ target: clickTarget({ toggle }) });
  assert.equal(list.hidden, false);

  doc.listeners.get('keydown')({ key: 'Escape' });
  assert.equal(
    list.hidden,
    true,
    'Escape owns the drawer the way it owns a sheet',
  );
  assert.equal(toggle.focused, true, 'and leaves focus on the handle');
  control.destroy();
});
