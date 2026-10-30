import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_OVERLAY_SOURCE_ID,
  CARD_COHORT_LIMIT,
  ENTITY_PREFIX,
  LAYER_ID,
  activityIdFromPick,
  buildActivityCard,
  createActivityOverlayEntry,
  createSelectedActivityEntry,
  selectActivityCohort,
  sourceHost,
  statusLabel,
} from './policy.js';
import {
  SECTORS,
  TRANSPORT_ACTIVITIES,
  activitiesInSector,
  activityCountries,
} from './data.js';

const translate = (text) => text;

test('every activity has a stable identity and a place on the globe', () => {
  const ids = new Set();
  for (const record of TRANSPORT_ACTIVITIES) {
    assert.match(record.id, /^[a-z0-9-]+$/, record.id);
    assert.ok(!ids.has(record.id), `duplicate id ${record.id}`);
    ids.add(record.id);
    assert.ok(Number.isFinite(record.lat), `${record.id} lat`);
    assert.ok(Number.isFinite(record.lon), `${record.id} lon`);
    assert.ok(Math.abs(record.lat) <= 90, `${record.id} lat range`);
    assert.ok(Math.abs(record.lon) <= 180, `${record.id} lon range`);
    for (const field of ['company', 'country', 'place', 'project', 'role']) {
      assert.ok(
        typeof record[field] === 'string' && record[field].trim(),
        `${record.id} ${field}`,
      );
    }
    assert.ok(SECTORS.includes(record.sector), `${record.id} sector`);
    assert.match(record.source.url, /^https?:\/\//, `${record.id} source`);
  }
});

test('no record claims a railway activity the research could not verify', () => {
  // The layer ships ports, airports, roads, bridges and shipping only: an
  // empty sector is the documented result, not a gap to fill with a guess.
  assert.deepEqual([...SECTORS], [
    'port',
    'airport',
    'road',
    'bridge',
    'shipping',
    'logistics',
  ]);
  assert.equal(activitiesInSector('rail').length, 0);
});

test('sectors and countries are counted from the data, not hard-coded', () => {
  assert.ok(activitiesInSector('port').length >= 2);
  assert.ok(activitiesInSector('airport').length >= 4);
  const countries = activityCountries();
  assert.ok(countries.includes('Spain'));
  assert.ok(countries.includes('Uganda'));
  assert.deepEqual(countries, [...countries].sort());
});

test('the site card reads as a fiche: who, what, role, state, where', () => {
  const record = TRANSPORT_ACTIVITIES.find((r) => r.id === 'sbi-kabaale');
  const card = buildActivityCard(record, translate);
  assert.equal(card.title, 'Kabaale, Hoima');
  assert.match(card.details[0], /Shikun & Binui \/ SBI · Airport/);
  assert.match(card.details[1], /Kabaale International Airport/);
  assert.match(card.details[2], /control tower/);
  assert.match(card.details[3], /Under construction · 2018/);
  assert.equal(card.details[4], 'Uganda · sbi.co.ug');
  assert.equal(new Set(card.details).size, card.details.length);
});

test('a card line is clamped and never empty', () => {
  const card = buildActivityCard(
    {
      company: 'C',
      sector: 'port',
      project: 'P',
      role: 'x'.repeat(200),
      status: 'operating',
      period: '2020',
      country: 'Spain',
      place: 'Somewhere',
      source: { url: 'https://example.org/a' },
    },
    translate,
  );
  assert.ok(card.details.every((line) => line.length <= 64));
  assert.ok(card.details[2].endsWith('...'));
});

test('an unknown status still says something', () => {
  assert.equal(statusLabel('dormant', translate), 'dormant');
  assert.equal(statusLabel('', translate), '');
});

test('source hosts lose the www prefix, and a broken link yields nothing', () => {
  assert.equal(sourceHost('https://www.magalsolutions.com/x'), 'magalsolutions.com');
  assert.equal(sourceHost('not a url'), '');
});

test('entity ids are namespaced so a click cannot be misattributed', () => {
  assert.equal(activityIdFromPick(`${ENTITY_PREFIX}zim-haifa`), 'zim-haifa');
  assert.equal(activityIdFromPick('railway-stations:node/1'), null);
  assert.equal(activityIdFromPick(''), null);
  assert.equal(activityIdFromPick(undefined), null);
});

test('the ambient label is a label, and the selected card is protected', () => {
  const record = TRANSPORT_ACTIVITIES[0];
  const position = { x: 1, y: 2, z: 3 };
  const label = createActivityOverlayEntry(record, position);
  assert.equal(label.variant, 'label');
  assert.equal(label.collisionGroup, 'ambient-label');
  assert.equal(label.interactive, false);

  const selected = createSelectedActivityEntry(
    record,
    position,
    buildActivityCard(record, translate),
  );
  assert.equal(selected.variant, 'selected');
  assert.equal(selected.selected, true);
  assert.equal(selected.protected, true);
  assert.equal(selected.priority, Number.MAX_SAFE_INTEGER);
  assert.ok(selected.details.length >= 4);
});

test('a card without a title or position is refused rather than painted', () => {
  const record = TRANSPORT_ACTIVITIES[0];
  assert.equal(
    createSelectedActivityEntry(record, null, { title: 'x', details: [] }),
    null,
  );
  assert.equal(
    createSelectedActivityEntry(record, { x: 0, y: 0, z: 0 }, {
      title: '',
      details: [],
    }),
    null,
  );
});

test('the cohort keeps the cap and breaks ties deterministically', () => {
  const entries = TRANSPORT_ACTIVITIES.map((record, index) =>
    createActivityOverlayEntry(record, { x: index, y: 0, z: 0 }),
  );
  const cohort = selectActivityCohort(entries);
  assert.equal(cohort.length, Math.min(entries.length, CARD_COHORT_LIMIT));
  assert.deepEqual(
    selectActivityCohort(entries, 0),
    [],
  );
  const first = selectActivityCohort(entries, 3).map((entry) => entry.id);
  const again = selectActivityCohort(entries.slice().reverse(), 3).map(
    (entry) => entry.id,
  );
  assert.deepEqual(first, again);
});

test('the layer keeps its own overlay sources', () => {
  assert.equal(LAYER_ID, 'israeli-transport');
  assert.equal(ACTIVITY_OVERLAY_SOURCE_ID, 'israeli-transport');
});
