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
  const dispatched = [];
  const listeners = new Map();
  const document = {
    createElement: node,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event) {
      dispatched.push(event);
      for (const handler of listeners.get(event.type) || []) handler(event);
      return true;
    },
  };
  const badge = node('span');
  badge.textContent = '0 events';
  const panel = { querySelector: () => badge };
  const host = node('div');
  host.ownerDocument = document;
  host.panel = panel;
  return { host, badge, dispatched };
}

function event(index) {
  return {
    id: `e${index}`,
    ordinal: index,
    lead: `${index} killed`,
    text: 'Battles · Ukraine',
    details: `Nov 20 · Armed Group A / Armed Group B`,
    date: 'Nov 20',
    actors: 'Armed Group A / Armed Group B',
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
  generatedAt = null,
  refresh,
} = {}) {
  const listeners = [];
  const layer = {
    rows,
    error,
    generatedAt,
    refreshCalls: 0,
    getRecentEvents: (limit) => rows.slice(0, limit),
    getRowControls: () => ({ info }),
    getLastError: () => layer.error,
    getStats: () => ({
      count: rows.length,
      generatedAt: layer.generatedAt,
      lastError: layer.error,
    }),
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
  const fix = panelHost.children.find(
    (child) => child.className === 'conflict-panel-fix',
  );
  const freshness = panelHost.children.find(
    (child) => child.className === 'conflict-panel-freshness',
  );
  const freshnessText = freshness?.children.find(
    (child) => child.className === 'conflict-panel-freshness-text',
  );
  const refreshButton = freshness?.children.find(
    (child) => child.className === 'conflict-panel-refresh',
  );
  const credit = panelHost.children.find(
    (child) => child.className === 'conflict-panel-credit',
  );
  const creditLink = credit?.children.find((child) => child.tagName === 'A');
  const creditMeta = credit?.children.at(-1);
  return {
    errorLine,
    list,
    status,
    fix,
    freshness,
    freshnessText,
    refreshButton,
    credit,
    creditLink,
    creditMeta,
  };
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
  assert.match(errorLine.textContent, /POWER UP/);
  assert.match(errorLine.textContent, /Provider Settings/);
  assert.doesNotMatch(errorLine.textContent, /\.env/);
  assert.match(errorLine.getAttribute('aria-label'), /Retry the read/);
  assert.equal(status.hidden, true);
  panel.destroy();
});

test('a missing ACLED key opens POWER UP at that exact row', () => {
  const { dataManager } = fakeManager({ error: 'no_key' });
  const { host, dispatched } = fakeHost();
  const panel = createConflictPanel({ container: host, dataManager });

  const { fix } = render(host);
  assert.ok(fix, 'the window must render the fix action');
  assert.equal(fix.tagName, 'BUTTON');
  assert.equal(fix.type, 'button');
  assert.equal(fix.hidden, false);
  assert.equal(fix.textContent, 'POWER UP');
  assert.match(fix.getAttribute('aria-label'), /ACLED_EMAIL/);

  fix.onclick();
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'gev:open-key-setup');
  assert.deepEqual(dispatched[0].detail, { keyId: 'acled' });
  panel.destroy();
});

test('a rejected pair still offers the row that replaces it', () => {
  const { dataManager } = fakeManager({ error: 'auth' });
  const { host } = fakeHost();
  const panel = createConflictPanel({ container: host, dataManager });

  const { fix } = render(host);
  assert.equal(fix.hidden, false);
  assert.match(fix.getAttribute('aria-label'), /rejected the credentials/);
  panel.destroy();
});

test('an upstream failure keeps retry, not POWER UP, as the offered action', () => {
  const { dataManager } = fakeManager({ error: 'upstream' });
  const { host } = fakeHost();
  const panel = createConflictPanel({ container: host, dataManager });

  const { errorLine, fix } = render(host);
  assert.equal(errorLine.hidden, false);
  assert.equal(fix.hidden, true);
  panel.destroy();
});

test('selecting a dot opens the window, marks its row, and shows date and actors', () => {
  const manager = fakeManager({
    rows: [event(1), event(2), event(3)],
  });
  const { host } = fakeHost();
  let revealed = 0;
  const panel = createConflictPanel({
    container: host,
    dataManager: manager.dataManager,
    reveal: () => {
      revealed += 1;
    },
  });
  const { list } = render(host);

  host.ownerDocument.dispatchEvent(
    new CustomEvent('gev:conflict-event-selected', {
      detail: { eventId: 'e2' },
    }),
  );

  assert.equal(revealed, 1, 'the window is revealed for the selected dot');
  const button = list.children[1].children[0];
  assert.match(button.className, /\bactive\b/);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  const details = button.children.find(
    (child) => child.className === 'data-row-list-details',
  );
  assert.ok(details, 'the row carries a second line');
  assert.match(details.textContent, /Nov 20/);
  assert.match(details.textContent, /Armed Group A/);

  // Teardown releases the document listener, so a later pick cannot revive a
  // destroyed window.
  panel.destroy();
  host.ownerDocument.dispatchEvent(
    new CustomEvent('gev:conflict-event-selected', {
      detail: { eventId: 'e1' },
    }),
  );
  assert.equal(revealed, 1);
});

test('a selected event outside the top slice is still projected into the window', () => {
  const manager = fakeManager({ rows: [event(1)] });
  manager.layer.getRecentEvents = (limit, extraId) =>
    extraId === 'e9' ? [event(9), event(1)] : [event(1)];
  const { host } = fakeHost();
  const panel = createConflictPanel({
    container: host,
    dataManager: manager.dataManager,
  });
  const { list } = render(host);

  host.ownerDocument.dispatchEvent(
    new CustomEvent('gev:conflict-event-selected', {
      detail: { eventId: 'e9' },
    }),
  );

  assert.equal(list.children.length, 2);
  assert.equal(list.children[0].dataset.listItemId, 'e9');
  assert.match(list.children[0].children[0].className, /\bactive\b/);
  panel.destroy();
});

test('the freshness line states the snapshot age and REFRESH forces a read', async () => {
  const generatedAt = Date.now() - 120_000;
  const manager = fakeManager({ rows: [event(1)], generatedAt });
  const { host } = fakeHost();
  const panel = createConflictPanel({
    container: host,
    dataManager: manager.dataManager,
  });

  const { freshness, freshnessText, refreshButton } = render(host);
  assert.ok(freshness, 'the window must state the snapshot freshness');
  assert.match(freshnessText.textContent, /Feed updated/);
  assert.match(freshnessText.textContent, /2 minutes ago/);
  assert.equal(refreshButton.textContent, 'REFRESH');
  assert.equal(refreshButton.hidden, false);
  assert.equal(refreshButton.disabled, false);

  refreshButton.onclick();
  assert.equal(refreshButton.disabled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.layer.refreshCalls, 1);
  assert.equal(refreshButton.disabled, false);
  panel.destroy();
});

test('a layer without a successful read says no snapshot yet', () => {
  const { dataManager } = fakeManager();
  const { host } = fakeHost();
  const panel = createConflictPanel({ container: host, dataManager });

  const { freshnessText } = render(host);
  assert.equal(freshnessText.textContent, 'No snapshot yet');
  panel.destroy();
});

test('the window credits ACLED, links its source, and states the access date', () => {
  const manager = fakeManager({
    rows: [event(1)],
    generatedAt: Date.parse('2026-11-20T12:00:00Z'),
  });
  const { host } = fakeHost();
  const panel = createConflictPanel({
    container: host,
    dataManager: manager.dataManager,
  });

  const { credit, creditLink, creditMeta } = render(host);
  assert.ok(credit, 'the window must carry the ACLED source credit');
  assert.equal(creditLink.textContent, 'acleddata.com');
  assert.equal(creditLink.href, 'https://acleddata.com');
  assert.equal(creditLink.target, '_blank');
  assert.equal(creditLink.rel, 'noopener');
  assert.match(creditMeta.textContent, /Last 7 days/);
  assert.match(creditMeta.textContent, /accessed/);
  assert.match(creditMeta.textContent, /2026/);
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
