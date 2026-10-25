import test from 'node:test';
import assert from 'node:assert/strict';
import { RADIATION_NETWORKS } from './records.js';
import {
  RADIATION_HIDDEN_NETWORKS_STORAGE_KEY as TOGGLES_KEY,
  radiationNetworkList,
  readHiddenNetworks,
  sanitizeHiddenNetworks,
  setNetworkVisible,
  visibleStations,
  writeHiddenNetworks,
} from './networks.js';

function fakeStorage(initial = null) {
  const map = new Map(initial ? [[TOGGLES_KEY, initial]] : []);
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    read: () => map.get(TOGGLES_KEY) ?? null,
  };
}

test('the hidden set keeps only networks this build registers', () => {
  // Storage is editable by hand and outlives a release: a network dropped from
  // the registry must not survive as a hidden id nobody can switch back on.
  assert.deepEqual(
    [...sanitizeHiddenNetworks(['bfs', 'gone', 42, null, 'radmon'])],
    ['bfs', 'radmon'],
  );
  assert.deepEqual(
    [...sanitizeHiddenNetworks('["radmon","bfs"]')],
    ['bfs', 'radmon'],
  );
  assert.equal(sanitizeHiddenNetworks('{not json').size, 0);
  assert.equal(sanitizeHiddenNetworks(null).size, 0);
});

test('the preference survives a reload and a broken storage does not throw', () => {
  const storage = fakeStorage();
  const hidden = writeHiddenNetworks(storage, ['uradmonitor']);
  assert.deepEqual([...hidden], ['uradmonitor']);
  assert.deepEqual([...readHiddenNetworks(storage)], ['uradmonitor']);

  const hostile = {
    getItem() {
      throw new Error('private mode');
    },
    setItem() {
      throw new Error('quota');
    },
  };
  assert.equal(readHiddenNetworks(hostile).size, 0);
  assert.doesNotThrow(() => writeHiddenNetworks(hostile, ['bfs']));
  assert.equal(readHiddenNetworks(null).size, 0);
});

test('a switch flips one network and ignores an unknown id', () => {
  const on = setNetworkVisible(new Set(), 'safecast', false);
  assert.deepEqual([...on], ['safecast']);
  const back = setNetworkVisible(on, 'safecast', true);
  assert.equal(back.size, 0);
  assert.equal(on.size, 1, 'the previous set is not mutated');
  assert.equal(setNetworkVisible(new Set(), 'nope', false).size, 0);
});

test('hidden networks leave the drawn rows without touching the snapshot', () => {
  const stations = [
    { id: 'a', network: 'bfs' },
    { id: 'b', network: 'radmon' },
    { id: 'c', network: 'bfs' },
  ];
  const visible = visibleStations(stations, new Set(['radmon']));
  assert.deepEqual(
    visible.map((row) => row.id),
    ['a', 'c'],
  );
  assert.equal(visibleStations(stations, new Set()), stations);
  assert.deepEqual(visibleStations(null, new Set(['bfs'])), []);
});

test('the switch list follows the registry and carries each count', () => {
  const toggles = [];
  const list = radiationNetworkList({
    hidden: new Set(['radmon']),
    sources: [
      { id: 'bfs', ok: true, count: 1566 },
      { id: 'canada', ok: true, count: 82 },
      { id: 'safecast', ok: true, count: 999 },
      { id: 'radmon', ok: true, count: 283 },
      // uRADMonitor is absent: this server has no keys for it.
    ],
    onToggle: (id, visible) => toggles.push([id, visible]),
  });

  assert.equal(list.ordered, false, 'a set of peers, not a sequence');
  assert.deepEqual(
    list.items.map((item) => item.id),
    Object.keys(RADIATION_NETWORKS),
    'registry order, not the order the answer arrived in',
  );
  const byId = (id) => list.items.find((item) => item.id === id);
  assert.equal(byId('bfs').checked, true);
  assert.equal(byId('bfs').text, 'BfS ODL · 1566');
  assert.match(byId('bfs').title, /1566/);
  assert.equal(byId('radmon').checked, false);
  assert.equal(byId('radmon').text, 'radmon.org · 283');
  // Nobody has a uRADMonitor unit on this account: the switch still lists it,
  // with a count and the reason it is empty.
  assert.equal(byId('uradmonitor').text, 'uRADMonitor');
  assert.equal(byId('uradmonitor').checked, true);
  assert.match(byId('uradmonitor').title, /Stations: 0/);
  assert.match(byId('uradmonitor').title, /API key/);

  byId('radmon').onClick();
  byId('safecast').onClick();
  assert.deepEqual(toggles, [
    ['radmon', true],
    ['safecast', false],
  ]);
});

test('a failed network reads as unavailable instead of as an empty one', () => {
  const list = radiationNetworkList({
    hidden: new Set(),
    sources: [
      { id: 'bfs', ok: false, count: 0, error: 'upstream_unavailable' },
      { id: 'uradmonitor', ok: true, count: 0 },
    ],
    onToggle: () => {},
  });
  const byId = (id) => list.items.find((item) => item.id === id);
  assert.match(byId('bfs').title, /Unavailable/);
  assert.doesNotMatch(byId('uradmonitor').title, /Unavailable/);
  assert.doesNotMatch(byId('uradmonitor').title, /API key/);
});
