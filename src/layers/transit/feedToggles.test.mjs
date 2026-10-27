import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSIT_ENABLED_FEEDS } from '../../data/transitFeeds.js';
import {
  TRANSIT_HIDDEN_FEEDS_STORAGE_KEY as TOGGLES_KEY,
  readHiddenFeeds,
  sanitizeHiddenFeeds,
  setFeedVisible,
  transitNetworkList,
  writeHiddenFeeds,
} from './feedToggles.js';
import { createControls } from './controls.js';

function fakeStorage(initial = null) {
  const map = new Map(initial ? [[TOGGLES_KEY, initial]] : []);
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    read: () => map.get(TOGGLES_KEY) ?? null,
  };
}

test('the hidden set keeps only ids this build registers', () => {
  // Storage is editable by hand and outlives a release: a feed dropped from the
  // registry must not survive as a hidden id nobody can switch back on.
  assert.deepEqual(
    [...sanitizeHiddenFeeds(['tam-montpellier', 'gone-feed', 42, null])],
    ['tam-montpellier'],
  );
  assert.deepEqual(
    [...sanitizeHiddenFeeds(new Set(['star-rennes']))],
    ['star-rennes'],
  );
  assert.deepEqual(
    [...sanitizeHiddenFeeds('["divia-dijon"]')],
    ['divia-dijon'],
  );
  assert.equal(sanitizeHiddenFeeds('not json').size, 0);
  assert.equal(sanitizeHiddenFeeds({ nope: true }).size, 0);
  assert.equal(sanitizeHiddenFeeds(null).size, 0);
});

test('a stored choice is read back, and a hostile store only costs the choice', () => {
  const storage = fakeStorage('["bibus-brest","unknown"]');
  assert.deepEqual([...readHiddenFeeds(storage)], ['bibus-brest']);
  assert.equal(readHiddenFeeds(fakeStorage('{oops')).size, 0);
  assert.equal(readHiddenFeeds(null).size, 0);
  // Safari's private mode throws on write; the layer still works for the session.
  const broken = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  assert.equal(readHiddenFeeds(broken).size, 0);
  assert.deepEqual(
    [...writeHiddenFeeds(broken, ['cap-cotentin'])],
    ['cap-cotentin'],
  );
});

test('writing keeps the registry order and drops the ids it cannot show', () => {
  const storage = fakeStorage();
  writeHiddenFeeds(storage, ['cap-cotentin', 'not-a-feed', 'star-rennes']);
  assert.deepEqual(JSON.parse(storage.read()), ['star-rennes', 'cap-cotentin']);
});

test('a switch flips exactly one network and returns a new set', () => {
  const hidden = new Set(['star-rennes']);
  const off = setFeedVisible(hidden, 'tam-montpellier', false);
  assert.deepEqual([...hidden], ['star-rennes'], 'the caller set is untouched');
  assert.deepEqual([...off], ['star-rennes', 'tam-montpellier']);
  const back = setFeedVisible(off, 'star-rennes', true);
  assert.deepEqual([...back], ['tam-montpellier']);
  assert.deepEqual(
    [...setFeedVisible(back, 'nope', false)],
    ['tam-montpellier'],
  );
});

test('the row lists every registered network, on or off', () => {
  const hidden = new Set(['tam-montpellier']);
  const list = transitNetworkList({ hidden, onToggle: () => {} });
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, TRANSIT_ENABLED_FEEDS.length);
  assert.deepEqual(
    list.items.map((item) => item.id),
    TRANSIT_ENABLED_FEEDS.map((feed) => feed.id),
    'registry order, so the list groups the way the panel does',
  );
  const hiddenItem = list.items.find((item) => item.id === 'tam-montpellier');
  assert.equal(hiddenItem.checked, false);
  assert.match(hiddenItem.title, /Hidden/);
  const rennes = list.items.find((item) => item.id === 'star-rennes');
  assert.equal(rennes.checked, true);
  assert.match(rennes.title, /Shown/);
  // A switch carries a real action, which is what the panel calls on click.
  const calls = [];
  const wired = transitNetworkList({
    hidden,
    onToggle: (id, visible) => calls.push([id, visible]),
  });
  wired.items.find((item) => item.id === 'tam-montpellier').onClick();
  assert.deepEqual(calls, [['tam-montpellier', true]]);
});

test('the controls persist a flip, redraw the row and re-run the poll', () => {
  const storage = fakeStorage();
  const state = { _hiddenFeeds: new Set(), _storage: storage };
  let proximity = 0;
  let notified = 0;
  const { methods } = createControls({
    state,
    parts: { viewport: { runProximityCheck: () => proximity++ } },
  });
  methods.setRowControlsListener(() => notified++);

  assert.equal(methods.setFeedVisible('palmbus-cannes', false), true);
  assert.deepEqual([...state._hiddenFeeds], ['palmbus-cannes']);
  assert.deepEqual(JSON.parse(storage.read()), ['palmbus-cannes']);
  assert.equal(proximity, 1, 'the hidden network leaves the globe now');
  assert.equal(notified, 1, 'the row repaints without waiting for a poll');

  // The same switch twice is not a change: no write, no poll, no repaint.
  assert.equal(methods.setFeedVisible('palmbus-cannes', false), false);
  assert.equal(proximity, 1);
  assert.equal(notified, 1);

  assert.deepEqual(
    methods
      .getRowControls()
      .list.items.find((item) => item.id === 'palmbus-cannes').checked,
    false,
  );

  assert.equal(methods.setFeedVisible('palmbus-cannes', true), true);
  assert.deepEqual(JSON.parse(storage.read()), []);
  assert.equal(proximity, 2);
  assert.deepEqual(methods.getHiddenFeeds(), []);
});
