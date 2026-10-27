import test from 'node:test';
import assert from 'node:assert/strict';

test('a switch list is a ul of role=switch entries and its click reaches the layer', async () => {
  const { LayerPanel } = await import('./layerPanel.js');
  const { railFixture } = await import('./railTestFixture.mjs');
  const f = railFixture();
  const previousDocument = globalThis.document;
  globalThis.document = f.document;

  // Two networks, one of them off — exactly what the Transit row describes.
  const state = { hidden: new Set(['palmbus-cannes']) };
  const clicks = [];
  const layer = {
    id: 'transit',
    name: 'Transit',
    icon: '🚌',
    source: 'GTFS-Realtime',
    enabled: true,
    showInTogglePanel: true,
    stats: { count: 12 },
  };
  const panel = new LayerPanel({
    getLayers: () => [layer],
    isEnabled: () => true,
    setEnabled() {},
    setLayerParams(...args) {
      clicks.push(args);
    },
    hasRowControls: () => true,
    subscribeRowControls() {},
    getRowControls: () => ({
      list: {
        ordered: false,
        ariaLabel: 'Transit networks',
        items: [
          {
            id: 'star-rennes',
            text: 'STAR',
            lead: '🚌',
            checked: !state.hidden.has('star-rennes'),
            title: 'STAR — Rennes Métropole',
            onClick: () => clicks.push(['star-rennes']),
          },
          {
            id: 'palmbus-cannes',
            text: 'Palmbus',
            lead: '🚌',
            checked: !state.hidden.has('palmbus-cannes'),
            title: 'Palmbus — Cannes Lérins',
            onClick: () => clicks.push(['palmbus-cannes']),
          },
        ],
      },
    }),
  });
  try {
    panel.mount(f.container);
    // The row owns two list containers; the switches are the `list` one, so
    // select the sequence class rather than whichever node comes first.
    const list = f.find((node) =>
      node.classList?.contains('data-row-list--sequence'),
    );
    assert.ok(list, 'the row carries a list');
    // A set of peers is a <ul>; only a sequence is an <ol>.
    assert.equal(list.tagName, 'UL');
    assert.ok(list.classList.contains('switches'));
    assert.equal(list.children.length, 2);

    const [shown, hidden] = list.children.map((li) =>
      li.querySelector('.data-row-list-item'),
    );
    assert.equal(shown.getAttribute('role'), 'switch');
    assert.equal(shown.getAttribute('aria-checked'), 'true');
    assert.equal(hidden.getAttribute('aria-checked'), 'false');
    assert.equal(shown.dataset.checked, 'true');
    assert.equal(hidden.dataset.checked, 'false');
    // The switch is drawn by the stylesheet, so the node has to exist.
    assert.ok(shown.querySelector('.data-row-list-switch'));
    assert.equal(shown.title, 'STAR — Rennes Métropole');

    hidden.click();
    assert.deepEqual(clicks.at(-1), ['palmbus-cannes']);
    // The panel hands a switch's action to the layer; it never invents a
    // parameter payload of its own for it.
    assert.equal(
      clicks.some((entry) => entry.length === 3),
      false,
    );
  } finally {
    panel.destroy();
    globalThis.document = previousDocument;
  }
});
