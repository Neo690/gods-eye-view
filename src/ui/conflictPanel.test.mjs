// src/ui/conflictPanel.test.mjs
// The conflict window: longer list than the row, follows the layer, never blank,
// states the source error code, and retries the read without a page reload.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONFLICT_LAYER_ID,
  CONFLICT_PANEL_ID,
  createConflictPanel,
} from './conflictPanel.js';

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
  const attributes = {};
  const element = {
    tagName: tag.toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    hidden: false,
    disabled: false,
    className: '',
    id: '',
    title: '',
    textContent: '',
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    append(...kids) {
      for (const kid of kids) element.appendChild(kid);
    },
    appendChild(kid) {
      element.children.push(kid);
      kid.parentNode = element;
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
      attributes[name] = String(value);
      element[name] = String(value);
    },
    getAttribute(name) {
      return attributes[name] ?? null;
    },
    removeAttribute(name) {
      delete attributes[name];
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

function fakeHost() {
  const document = { createElement: node };
  const badge = node('span');
  badge.textContent = '0 events';
  const panel = { querySelector: () => badge };
  const host = node('div');
  host.ownerDocument = document;
  host.panel = panel;
  return { host, badge };
}

function event(index) {
  return {
    id: `e${index}`,
    ordinal: index,
    lead: `${index} killed`,
    text: 'Battles · Ukraine',
    accent: '#ffd700',
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeManager({
  rows = [],
  info = 'ACLED · Last 7 days · 0 events',
  error = null,
  refresh,
} = {}) {
  const listeners = [];
  const layer = {
    rows,
    error,
    refreshCalls: 0,
    getRecentEvents: (limit) => rows.slice(0, limit),
    getRowControls: () => ({ info }),
    getLastError: () => layer.error,
    refresh: async () => {
      layer.refreshCalls += 1;
      if (refresh) return refresh(layer);
      return true;
    },
  };
  return {
    listeners,
    layer,
    dataManager: {
      layers: new Map([[CONFLICT_LAYER_ID, { module: layer }]]),
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

function render(panelHost) {
  const errorLine = panelHost.children.find(
    (child) => child.className === 'conflict-panel-error',
  );
  const list = panelHost.children.find(
    (child) => child.className === 'data-row-list',
  );
  const status = panelHost.children.find(
    (child) => child.className === 'conflict-panel-status',
  );
  return { errorLine, list, status };
}

test('the window lists more than the row card five', () => {
  const rows = Array.from({ length: 9 }, (_, index) => event(index + 1));
  const { dataManager } = fakeManager({ rows });
  const { host, badge } = fakeHost();
  const panel = createConflictPanel({ container: host, dataManager });

  const { list } = render(host);
  assert.ok(list, 'the window must render a list');
  assert.equal(list.children.length, 9);
  assert.equal(list.hidden, false);
  assert.match(badge.textContent, /9/);
  panel.destroy();
});

test('the window follows the layer instead of polling it', () => {
  const manager = fakeManager({ rows: [event(1)] });
  const { host } = fakeHost();
  const panel = createConflictPanel({
    container: host,
    dataManager: manager.dataManager,
  });
  const { list } = render(host);
  assert.equal(list.children.length, 1);

  manager.layer.rows.push(event(2), event(3));
  manager.listeners.forEach((listener) => listener());
  assert.equal(list.children.length, 3);
  panel.destroy();
});

test('a layer with no events states its own info line, not a blank box', () => {
  const { dataManager } = fakeManager({
    info: 'ACLED · Last 7 days · 0 events',
  });
  const { host } = fakeHost();
  const panel = createConflictPanel({ container: host, dataManager });

  const { list, status, errorLine } = render(host);
  assert.equal(list.hidden, true);
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'ACLED · Last 7 days · 0 events');
  assert.equal(errorLine.hidden, true);
  panel.destroy();
});

test('the source error code and its reason are shown, not hidden behind the list', () => {
  const { dataManager } = fakeManager({ rows: [event(1)], error: 'no_key' });
  const { host } = fakeHost();
  const panel = createConflictPanel({ container: host, dataManager });

  const { errorLine, status } = render(host);
  assert.equal(errorLine.hidden, false);
  assert.equal(errorLine.getAttribute('data-code'), 'no_key');
  assert.equal(errorLine.tagName, 'BUTTON');
  assert.equal(errorLine.type, 'button');
  assert.match(errorLine.textContent, /no_key/);
  assert.match(errorLine.textContent, /ACLED_EMAIL/);
  assert.match(errorLine.getAttribute('aria-label'), /Retry the read/);
  assert.equal(status.hidden, true);
  panel.destroy();
});

test('clicking the error asks the layer for a fresh read', async () => {
  const manager = fakeManager({ rows: [event(1)], error: 'no_key' });
  const { host } = fakeHost();
  const panel = createConflictPanel({
    container: host,
    dataManager: manager.dataManager,
  });
  const { errorLine } = render(host);
  errorLine.onclick();
  assert.equal(errorLine.disabled, true);
  assert.equal(errorLine.getAttribute('aria-busy'), 'true');
  assert.match(errorLine.textContent, /Retrying/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.layer.refreshCalls, 1);
  assert.equal(errorLine.disabled, false);
  assert.equal(errorLine.getAttribute('aria-busy'), null);
  // The failure is still there, so the line returns to it.
  assert.match(errorLine.textContent, /no_key/);
  panel.destroy();
});

test('a successful retry clears the line and shows the events', async () => {
  const manager = fakeManager({
    rows: [event(1)],
    error: 'auth',
    refresh: (layer) => {
      layer.error = null;
      layer.rows.push(event(2));
      return true;
    },
  });
  const { host } = fakeHost();
  const panel = createConflictPanel({
    container: host,
    dataManager: manager.dataManager,
  });
  const { errorLine, list } = render(host);
  assert.equal(errorLine.hidden, false);

  errorLine.onclick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errorLine.hidden, true);
  assert.equal(list.children.length, 2);
  assert.equal(list.hidden, false);
  panel.destroy();
});

test('a second click while the read is in flight is ignored', async () => {
  const pending = deferred();
  const manager = fakeManager({
    error: 'upstream',
    refresh: () => pending.promise,
  });
  const { host } = fakeHost();
  const panel = createConflictPanel({
    container: host,
    dataManager: manager.dataManager,
  });
  const { errorLine } = render(host);

  errorLine.onclick();
  errorLine.onclick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.layer.refreshCalls, 1);
  pending.resolve(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errorLine.disabled, false);
  panel.destroy();
});

test('a stale list still shows its rows while declaring the failure', () => {
  const { dataManager } = fakeManager({
    rows: [event(1), event(2)],
    error: 'upstream',
  });
  const { host } = fakeHost();
  const panel = createConflictPanel({ container: host, dataManager });

  const { list, errorLine } = render(host);
  assert.equal(list.hidden, false);
  assert.equal(list.children.length, 2);
  assert.equal(errorLine.hidden, false);
  assert.match(errorLine.textContent, /upstream/);
  panel.destroy();
});

test('a recovered feed clears the error line', () => {
  const manager = fakeManager({ rows: [event(1)], error: 'auth' });
  const { host } = fakeHost();
  const panel = createConflictPanel({
    container: host,
    dataManager: manager.dataManager,
  });
  assert.equal(render(host).errorLine.hidden, false);

  manager.layer.error = null;
  manager.listeners.forEach((listener) => listener());
  assert.equal(render(host).errorLine.hidden, true);
  panel.destroy();
});

test('an unknown code still shows the token, without inventing a reason', () => {
  const { dataManager } = fakeManager({ error: 'rate_limited' });
  const { host } = fakeHost();
  const panel = createConflictPanel({ container: host, dataManager });

  const { errorLine } = render(host);
  assert.match(errorLine.textContent, /rate_limited/);
  panel.destroy();
});

test('a layer that is not registered yet yields an empty window, not a crash', () => {
  const { host } = fakeHost();
  const panel = createConflictPanel({
    container: host,
    dataManager: { layers: new Map(), subscribe: () => () => {} },
  });
  const { status } = render(host);
  assert.equal(status.hidden, false);
  panel.destroy();
});

test('without a container or a manager there is no window', () => {
  assert.equal(createConflictPanel({}), null);
  assert.equal(createConflictPanel({ container: fakeHost().host }), null);
  assert.equal(CONFLICT_PANEL_ID, 'conflict-panel');
});
