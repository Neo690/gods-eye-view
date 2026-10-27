import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CommandPalette,
  fold,
  groupEntries,
  matchScore,
  moveSelection,
  rankEntries,
} from './commandPalette.js';

test('matching ignores case and accents, and ranks where the query lands', () => {
  assert.equal(fold('MÉTÉO'), 'meteo');
  assert.equal(
    matchScore('Météo', 'meteo'),
    0,
    'the folded label is the query',
  );
  assert.equal(matchScore('Météo actuelle', 'meteo'), 1);
  assert.equal(matchScore('Radio Sites', 'radio'), 1);
  assert.equal(matchScore('Radio Sites', 'sit'), 2, 'a word start matches');
  assert.equal(
    matchScore('openSenseMap', 'sensemap'),
    3,
    'mid-word matches too',
  );
  assert.equal(matchScore('Radio Sites', 'zzz'), null);
  assert.equal(matchScore('Radio Sites', ''), 0, 'an empty query keeps rows');
  assert.equal(matchScore('', 'radio'), null);
});

test('ranking puts the strongest match first and keeps layers above panels', () => {
  const entries = [
    { id: 'panel:data-panel', kind: 'panel', label: 'Data layers' },
    { id: 'layer:earthquakes', kind: 'layer', label: 'Earthquakes' },
    { id: 'layer:radar', kind: 'layer', label: 'Radar' },
    { id: 'layer:weather-radar', kind: 'layer', label: 'Weather radar' },
  ];
  const ranked = rankEntries(entries, 'ra');
  assert.deepEqual(
    ranked.map((entry) => entry.id),
    ['layer:radar', 'layer:weather-radar'],
    'a prefix outranks a word start, and a row with no match is dropped',
  );
  assert.equal(ranked[0].score, 1);
  assert.equal(ranked[1].score, 2);

  const ties = rankEntries(
    [
      { id: 'panel:x', kind: 'panel', label: 'Radio' },
      { id: 'layer:radio', kind: 'layer', label: 'Radio' },
    ],
    'radio',
  );
  assert.deepEqual(
    ties.map((entry) => entry.id),
    ['layer:radio', 'panel:x'],
    'equal scores fall back to the kind order',
  );
});

test('a place never outranks the layer that carries the word', () => {
  // A geocoder answers to almost anything: "sites" resolves to a town in
  // California, which must not sit above the layer actually named Radio Sites.
  const ranked = rankEntries(
    [
      { id: 'place', kind: 'place', label: 'Sites, California', always: true },
      { id: 'layer:cell', kind: 'layer', label: 'Radio Sites' },
    ],
    'sites',
  );
  assert.deepEqual(
    ranked.map((entry) => entry.id),
    ['layer:cell', 'place'],
  );
});

test('the typed place survives a result cap the layers have filled', () => {
  const layers = Array.from({ length: 20 }, (_, index) => ({
    id: `layer:${index}`,
    kind: 'layer',
    label: `Paris layer ${index}`,
  }));
  const place = {
    id: 'place',
    kind: 'place',
    label: 'Paris, France',
    always: true,
  };
  const ranked = rankEntries([...layers, place], 'paris', { limit: 5 });
  assert.equal(ranked.length, 5);
  assert.equal(
    ranked.at(-1).id,
    'place',
    'the place row is the reason to type',
  );
});

test('the cursor wraps at both ends and an empty list stays at zero', () => {
  assert.equal(moveSelection(0, 1, 3), 1);
  assert.equal(moveSelection(2, 1, 3), 0);
  assert.equal(moveSelection(0, -1, 3), 2);
  assert.equal(moveSelection(0, 1, 0), 0);
});

test('one section per kind, in the order the ranking first met it', () => {
  const groups = groupEntries([
    { kind: 'layer', label: 'a' },
    { kind: 'panel', label: 'b' },
    { kind: 'layer', label: 'c' },
    { kind: 'place', label: 'd' },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.kind, group.entries.length]),
    [
      ['layer', 2],
      ['panel', 1],
      ['place', 1],
    ],
    'a second layer does not open a second DATA LAYERS heading',
  );
});

/** A palette with no DOM: results() is the part that decides what happens. */
function offlinePalette(actions) {
  return new CommandPalette({ root: null, documentRef: null, actions });
}

test('a layer row toggles the opposite of the state it reports', async () => {
  const calls = [];
  const palette = offlinePalette({
    getLayers: () => [
      { id: 'earthquakes', name: 'Earthquakes' },
      { id: 'flights', name: 'Flights' },
    ],
    isLayerEnabled: (id) => id === 'flights',
    setLayerEnabled: (id, enabled) => calls.push([id, enabled]),
  });
  const ranked = palette.results('fli');
  assert.equal(ranked.length, 1, 'only the matching layer is offered');
  assert.equal(ranked[0].detail.toUpperCase(), 'ON');
  await ranked[0].run();
  assert.deepEqual(calls, [['flights', false]], 'an enabled layer turns off');

  const off = palette.results('earth');
  assert.equal(off[0].detail.toUpperCase(), 'OFF');
  await off[0].run();
  assert.deepEqual(calls.at(-1), ['earthquakes', true]);
});

test('a panel row opens that panel and carries its own title', async () => {
  const opened = [];
  const palette = offlinePalette({
    getPanels: () => [
      { id: 'weather-panel', label: 'WEATHER' },
      { id: 'global-context-panel', label: 'CONTEXT' },
    ],
    openPanel: (id) => opened.push(id),
  });
  const ranked = palette.results('wea');
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].label, 'WEATHER');
  await ranked[0].run();
  assert.deepEqual(opened, ['weather-panel']);
});

test('a place row flies to what was typed, resolved label or not', async () => {
  const flown = [];
  const palette = offlinePalette({
    flyTo: (text) => flown.push(text),
  });
  assert.deepEqual(palette.results('p'), [], 'one letter is not a place query');
  const typed = palette.results('tour eiffel');
  assert.equal(typed.length, 1);
  assert.equal(
    typed[0].label,
    'tour eiffel',
    'the query answers before lookup',
  );
  await typed[0].run();
  assert.deepEqual(flown, ['tour eiffel']);
});
