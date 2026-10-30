import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_OVERLAY_SOURCE_ID,
  CARD_COHORT_LIMIT,
  ENTITY_PREFIX,
  LAYER_ID,
  activityIdFromPick,
  buildActivityCard,
  buildCompanyCard,
  companyEntityId,
  companyKeyFromPick,
  companyLinkEntityId,
  createCompanyOverlayEntry,
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
import { COMPANIES, COMPANIES_BY_KEY, companyFor } from './companies.js';

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

test('rail is carried, and only where the research found it', () => {
  // No overseas railway, metro or light-rail award by an Israeli company could
  // be verified while compiling the data, so the rail records are the Tel Aviv
  // Red Line works. The test keeps that finding: a later edit cannot quietly
  // move a rail record abroad, and an empty sector cannot reappear unnoticed.
  assert.deepEqual([...SECTORS], [
    'port',
    'rail',
    'airport',
    'road',
    'bridge',
    'shipping',
    'transit',
    'logistics',
  ]);
  const rail = activitiesInSector('rail');
  assert.ok(rail.length >= 1, 'the rail sector must hold the documented work');
  assert.ok(
    rail.every((record) => record.country === 'Israel'),
    'no rail record may sit outside Israel until a source says otherwise',
  );
  assert.ok(activitiesInSector('transit').length >= 4);
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

test('every company behind a site has a node, and every node has a site', () => {
  const keys = new Set();
  for (const company of COMPANIES) {
    assert.match(company.key, /^[a-z0-9-]+$/, company.key);
    assert.ok(!keys.has(company.key), `duplicate company ${company.key}`);
    keys.add(company.key);
    assert.ok(company.name.trim(), company.key);
    assert.ok(company.business.trim(), company.key);
    assert.match(company.source.url, /^https?:\/\//, company.key);
    assert.ok(
      Number.isFinite(company.hq.lat) && Number.isFinite(company.hq.lon),
      company.key,
    );
    if (company.parent)
      assert.ok(COMPANIES_BY_KEY[company.parent], `${company.key} parent`);
  }
  for (const record of TRANSPORT_ACTIVITIES) {
    const company = companyFor(record.company);
    assert.ok(company, `no company node for ${record.company}`);
    assert.ok(company.matches.includes(record.company) || record.company.startsWith(company.matches[0]), record.company);
  }
  for (const company of COMPANIES) {
    assert.ok(
      TRANSPORT_ACTIVITIES.some(
        (record) => companyFor(record.company)?.key === company.key,
      ),
      `${company.key} has no site in the layer`,
    );
  }
});

test('a record that names its group first still resolves to that group', () => {
  assert.equal(companyFor('Shikun & Binui / SBI').key, 'shikun-binui');
  assert.equal(companyFor('S&B USA (Shikun & Binui)').key, 'sb-usa');
  assert.equal(companyFor('Magal Security Systems').key, 'magal');
  assert.equal(companyFor('Gadot / Chemship').key, 'gadot-group');
  assert.equal(companyFor('Unknown Carrier Ltd'), null);
  assert.equal(companyFor(''), null);
});

test('the company fiche counts the sites the layer actually draws', () => {
  const company = COMPANIES_BY_KEY.zim;
  const sites = TRANSPORT_ACTIVITIES.filter(
    (record) => companyFor(record.company)?.key === company.key,
  );
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const card = buildCompanyCard(company, sites, translate, plural);
  assert.equal(card.title, company.name);
  assert.equal(card.details[0], company.business);
  assert.match(card.details[1], /^Headquarters: Haifa, Israel$/);
  assert.match(
    card.details[2],
    new RegExp(
      `^${sites.length} ${sites.length === 1 ? 'site' : 'sites'} · `,
    ),
  );
  assert.ok(
    card.details.every((line) => line.length <= 88),
    'every fiche line is clamped',
  );
  // No site: the card says so instead of printing an empty count.
  const empty = buildCompanyCard(company, [], translate, plural);
  assert.ok(empty.details.includes('No site in this layer'));
});

test('a hub click resolves to its company, a link to the company it belongs to', () => {
  assert.equal(companyKeyFromPick(companyEntityId('zim')), 'zim');
  assert.equal(companyKeyFromPick(companyLinkEntityId('zim', 'zim-ashdod')), 'zim');
  assert.equal(companyKeyFromPick(`${ENTITY_PREFIX}zim-ashdod`), null);
  assert.equal(companyKeyFromPick('railway-stations:node/1'), null);
  // A hub is never mistaken for a site.
  assert.equal(activityIdFromPick(companyEntityId('zim')), null);
  const entry = createCompanyOverlayEntry(COMPANIES_BY_KEY.zim, { x: 0, y: 0, z: 0 });
  assert.equal(entry.addressFree, undefined);
  assert.equal(entry.id, 'company-zim');
  assert.equal(entry.interactive, false);
  assert.ok(
    entry.priority >
      createActivityOverlayEntry(TRANSPORT_ACTIVITIES[0], { x: 0, y: 0, z: 0 })
        .priority,
    'a hub outranks its own sites in the cohort',
  );
});

test('the layer keeps its own overlay sources', () => {
  assert.equal(LAYER_ID, 'israeli-transport');
  assert.equal(ACTIVITY_OVERLAY_SOURCE_ID, 'israeli-transport');
});
