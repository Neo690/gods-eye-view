// src/ui/insiderPanel.test.mjs
// The insider window: full list, follows the layer, and never shows a blank box.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INSIDER_LAYER_ID,
  INSIDER_PANEL_ID,
  createInsiderPanel,
} from './insiderPanel.js';

function find(node, selector) {
  const key = selector.startsWith('.') ? 'className' : 'id';
  const want = selector.slice(1);
  for (const child of node.children) {
    if (child[key] === want) return child;
    const nested = find(child, selector);
    if (nested) return nested;
  }
  return null;
}

function node(tag = 'div') {
  const element = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    hidden: false,
    className: '',
    id: '',
    textContent: '',
    classList: {
      toggle() {},
      add() {},
      remove() {},
      contains: () => false,
    },
    append(...kids) {
      for (const kid of kids) element.appendChild(kid);
    },
    appendChild(kid) {
      element.children.push(kid);
      kid.parentNode = element;
      // syncRowList resolves elements through `container.ownerDocument`, so a
      // child has to inherit the host's document or it creates nothing.
      kid.ownerDocument = element.ownerDocument ?? element;
      return kid;
    },
    insertBefore(kid, reference) {
      const at = reference ? element.children.indexOf(reference) : -1;
      element.children.splice(at < 0 ? element.children.length : at, 0, kid);
      kid.parentNode = element;
      kid.ownerDocument = element.ownerDocument ?? element;
      return kid;
    },
    removeChild(kid) {
      const at = element.children.indexOf(kid);
      if (at >= 0) element.children.splice(at, 1);
      return kid;
    },
    remove() {
      element.parentNode?.removeChild(element);
    },
    setAttribute(name, value) {
      element[name] = String(value);
    },
    getAttribute(name) {
      return element[name] ?? null;
    },
    removeAttribute(name) {
      delete element[name];
    },
    querySelector(selector) {
      return (
        element.panel?.querySelector?.(selector) ?? find(element, selector)
      );
    },
    closest() {
      return element.panel ?? null;
    },
    scrollIntoView() {},
  };
  return element;
}

/** A host inside a fake insider panel that owns the count badge. */
function fakeHost() {
  const document = { createElement: node };
  const badge = node('span');
  badge.textContent = '0 filings';
  const panel = { querySelector: () => badge };
  const host = node('div');
  host.ownerDocument = document;
  host.panel = panel;
  return { host, badge };
}

function filing(index) {
  return {
    id: `f${index}`,
    ordinal: index + 1,
    lead: `Issuer ${index}`,
    text: `Owner ${index} · 2026-11-10`,
    accent: '#38bdf8',
  };
}

function fakeManager(rows, info = 'SEC EDGAR · 0 filings') {
  const listeners = [];
  const layer = {
    rows,
    getRecentFilings: (limit) => rows.slice(0, limit),
    getRowControls: () => ({ info }),
  };
  return {
    listeners,
    layer,
    dataManager: {
      layers: new Map([[INSIDER_LAYER_ID, { module: layer }]]),
      subscribe(callback) {
        listeners.push(callback);
        return () => {
          const at = listeners.indexOf(callback);
          if (at >= 0) listeners.splice(at, 1);
        };
      },
    },
  };
}

test('the window lists every filing the layer holds, not the row-card five', () => {
  const rows = Array.from({ length: 7 }, (_, index) => filing(index + 1));
  const { dataManager } = fakeManager(rows, 'SEC EDGAR · 7 filings');
  const { host, badge } = fakeHost();
  const panel = createInsiderPanel({ container: host, dataManager });

  const list = host.children.find(
    (child) => child.className === 'data-row-list',
  );
  assert.ok(list, 'the window must render a list');
  assert.equal(list.children.length, 7);
  assert.equal(list.hidden, false);
  assert.match(badge.textContent, /7/);
  assert.equal(panel?.render instanceof Function, true);
  panel.destroy();
});

test('the window follows the layer instead of polling it', () => {
  const rows = [filing(1)];
  const manager = fakeManager(rows);
  const { host } = fakeHost();
  const panel = createInsiderPanel({
    container: host,
    dataManager: manager.dataManager,
  });
  const list = host.children.find(
    (child) => child.className === 'data-row-list',
  );
  assert.equal(list.children.length, 1);

  manager.layer.rows.push(filing(2), filing(3));
  manager.listeners.forEach((listener) => listener());
  assert.equal(list.children.length, 3);
  panel.destroy();
});

test('a layer with no filings states its own info line, not a blank box', () => {
  const { dataManager } = fakeManager([], 'SEC EDGAR · 0 filings');
  const { host } = fakeHost();
  const panel = createInsiderPanel({ container: host, dataManager });

  const list = host.children.find(
    (child) => child.className === 'data-row-list',
  );
  const status = host.children.find(
    (child) => child.className === 'insider-panel-status',
  );
  assert.equal(list.hidden, true);
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'SEC EDGAR · 0 filings');
  panel.destroy();
});

test('a layer that is not registered yet yields an empty window, not a crash', () => {
  const { host } = fakeHost();
  const panel = createInsiderPanel({
    container: host,
    dataManager: { layers: new Map(), subscribe: () => () => {} },
  });
  const status = host.children.find(
    (child) => child.className === 'insider-panel-status',
  );
  assert.equal(status.hidden, false);
  panel.destroy();
});

test('without a container or a manager there is no window', () => {
  assert.equal(createInsiderPanel({}), null);
  assert.equal(createInsiderPanel({ container: fakeHost().host }), null);
  assert.equal(INSIDER_PANEL_ID, 'insider-panel');
});
