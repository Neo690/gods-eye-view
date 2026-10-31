import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WATCH_SOURCE_CAPS,
  WATCH_SOURCES,
  createConjunctionDetailEntry,
  formatCollisionProbability,
  relativeSpeedAt,
  fromCatalogEntries,
  fromN2yoAbove,
  fromSpaceTrackGp,
  fromTleApiMembers,
  conjunctionsFromCdm,
  missingSecondaryNorads,
  noradKey,
  orbitRegime,
  parseCdmMessage,
  parseN2yoPayload,
  sampleEvenly,
  watchSummary,
} from './model.js';
import { parseTleCatalog } from '../orbitChanges/model.js';

const ISS = [
  'ISS (ZARYA)',
  '1 25544U 98067A   24001.50000000  .00016717  00000+0  30777-3 0  9993',
  '2 25544  51.6416  90.5085 0004526  90.7038  51.2835 15.49512600  1234',
].join('\n');

const AT = new Date(Date.UTC(2024, 0, 1, 12));

/** A second object on a different plane, so a closing speed has a sign. */
const DEBRIS = [
  'COSMOS 2251 DEB',
  '1 47311U 93036ACB 24001.50000000  .00001234  00000-0  35000-3 0  9994',
  '2 47311  74.0500  12.3456 0012345 100.0000 260.0000 14.90000000  1234',
].join('\n');

test('five sources, each with its own colour and identity', () => {
  assert.equal(WATCH_SOURCES.length, 5);
  const ids = WATCH_SOURCES.map((source) => source.id);
  assert.deepEqual(ids, [
    'azmth',
    'orbital-radar',
    'war-monitor',
    'space-track',
    'n2yo',
  ]);
  for (const source of WATCH_SOURCES) {
    assert.match(source.color, /^#[0-9A-F]{6}$/i);
    assert.ok(source.label);
    assert.equal(source.detail, undefined);
  }
});

test('orbit regimes follow altitude, and an eccentric orbit is HEO', () => {
  assert.equal(orbitRegime(420), 'LEO');
  assert.equal(orbitRegime(20200), 'MEO');
  assert.equal(orbitRegime(35786), 'GEO');
  assert.equal(orbitRegime(1200, 0.4), 'HEO');
  assert.equal(orbitRegime(-5), 'SUB');
  assert.equal(orbitRegime('nope'), 'UNKNOWN');
});

test('sampling is even, deterministic and bounded', () => {
  const list = Array.from({ length: 100 }, (_, index) => index);
  assert.deepEqual(sampleEvenly(list, 5), [0, 20, 40, 60, 80]);
  assert.deepEqual(sampleEvenly(list, 5), sampleEvenly(list, 5));
  assert.equal(sampleEvenly(list, 0).length, 0);
  assert.equal(sampleEvenly(list, 500).length, 100);
  assert.deepEqual(sampleEvenly(null, 5), []);
});

test('CelesTrak element sets become positioned objects', () => {
  const entries = parseTleCatalog(ISS);
  const objects = fromCatalogEntries(entries, AT, 10);
  assert.equal(objects.length, 1);
  const [object] = objects;
  assert.equal(object.source, 'azmth');
  assert.equal(object.norad, '25544');
  assert.equal(object.name, 'ISS (ZARYA)');
  assert.ok(Number.isFinite(object.lat) && Number.isFinite(object.lon));
  // The ISS flies between 300 and 500 km.
  assert.ok(object.altitudeKm > 250 && object.altitudeKm < 550);
  assert.equal(object.regime, 'LEO');
  assert.equal(object.at, AT.getTime());
});

test('a broken element set is skipped, not rendered at 0,0', () => {
  const entries = parseTleCatalog(ISS);
  const broken = [{ ...entries[0], line1: 'garbage', line2: 'garbage' }];
  assert.deepEqual(fromCatalogEntries(broken, AT, 10), []);
});

test('the TLE catalogue mailer becomes War Monitor objects', () => {
  const entries = parseTleCatalog(ISS);
  const members = [
    {
      satelliteId: 25544,
      name: 'ISS (ZARYA)',
      line1: entries[0].line1,
      line2: entries[0].line2,
    },
    { satelliteId: 1, name: 'no elements' },
  ];
  const objects = fromTleApiMembers(members, AT, 10);
  assert.equal(objects.length, 1);
  assert.equal(objects[0].source, 'war-monitor');
  assert.equal(objects[0].norad, '25544');
});

test('N2YO above rows are used as sent', () => {
  const payload = {
    at: 1735732800000,
    above: [
      {
        satid: 25544,
        satname: 'ISS (ZARYA)',
        satlat: 12.5,
        satlng: -40.1,
        satalt: 418,
      },
      { satid: 2, satname: 'bad', satlat: 'x', satlng: null, satalt: 0 },
    ],
  };
  const objects = fromN2yoAbove(payload, 10);
  assert.equal(objects.length, 1);
  assert.equal(objects[0].altitudeKm, 418);
  assert.equal(objects[0].source, 'n2yo');
  assert.equal(objects[0].lat, 12.5);
  assert.equal(objects[0].altitudeKm, 418);
  assert.equal(objects[0].at, 1735732800000);
});

test('an N2YO error body is an error, not an empty answer', () => {
  assert.equal(parseN2yoPayload({ error: 'Invalid API Key!' }).ok, false);
  assert.equal(
    parseN2yoPayload({ error: 'Invalid API Key!' }).error,
    'Invalid API Key!',
  );
  const ok = parseN2yoPayload({ info: {}, above: [{ satid: 1 }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.above.length, 1);
  assert.equal(parseN2yoPayload(null).ok, true);
});

test('the summary names only the sources that hold something', () => {
  const counts = { azmth: 3, 'orbital-radar': 0, 'war-monitor': 2, n2yo: 0 };
  assert.equal(
    watchSummary(counts, 5, 'Objects tracked'),
    'Objects tracked: 5 · Azmth 3 · War Monitor 2',
  );
  assert.equal(watchSummary({ azmth: 0 }, 0, 'Objects tracked'), null);
});

test('Space-Track element sets propagate like the catalogue source', () => {
  const entries = parseTleCatalog(ISS);
  assert.equal(entries.length, 1);
  const objects = fromSpaceTrackGp(entries, AT, 10);
  assert.equal(objects.length, 1);
  assert.equal(objects[0].source, 'space-track');
  assert.equal(objects[0].norad, '25544');
  assert.ok(Number.isFinite(objects[0].altitudeKm));
});

test('a CDM row is read in either key case and its TCA is UTC', () => {
  const message = parseCdmMessage({
    CDM_ID: 987654,
    TCA: '2026-01-02 00:00:00',
    SAT_1_ID: 25544,
    SAT_1_NAME: 'ISS (ZARYA)',
    SAT_2_ID: 47311,
    SAT_2_NAME: 'COSMOS 2251 DEB',
    MIN_RNG: 0.083,
    PC: 0.000856,
    RELATIVE_SPEED: 14.23,
  });
  assert.equal(message.tca, Date.parse('2026-01-02T00:00:00Z'));
  assert.equal(message.primaryId, '25544');
  assert.equal(message.secondaryName, 'COSMOS 2251 DEB');
  assert.equal(message.minRangeKm, 0.083);
  assert.equal(message.pc, 0.000856);

  const lower = parseCdmMessage({
    sat_1_id: '25544',
    tca: '2026-01-02T00:00:00Z',
    min_rng: '1.5',
  });
  assert.equal(lower.tca, Date.parse('2026-01-02T00:00:00Z'));
  assert.equal(lower.minRangeKm, 1.5);
  assert.equal(parseCdmMessage({ SAT_1_ID: 25544 }), null);
  assert.equal(parseCdmMessage(null), null);
});

test('conjunctions are placed from the primary element set at TCA', () => {
  const entries = parseTleCatalog(ISS);
  const message = parseCdmMessage({
    CDM_ID: 1,
    TCA: '2024-01-01 12:00:00',
    SAT_1_ID: 25544,
    SAT_1_NAME: 'ISS (ZARYA)',
    SAT_2_NAME: 'DEBRIS',
    MIN_RNG: 0.2,
  });
  const events = conjunctionsFromCdm([message], entries, 10);
  assert.equal(events.length, 1);
  assert.equal(events[0].norad, '25544');
  assert.ok(Number.isFinite(events[0].lat));
  assert.ok(Number.isFinite(events[0].lon));
  // An unknown object is skipped rather than placed on a guess.
  const unknown = { ...message, primaryId: '99999' };
  assert.equal(conjunctionsFromCdm([unknown], entries, 10).length, 0);
  assert.equal(conjunctionsFromCdm([message], [], 10).length, 0);
});

test('a conjunction card names both objects, Pc, TCA, speed and source', () => {
  const entries = parseTleCatalog(ISS);
  const message = parseCdmMessage({
    CDM_ID: 42,
    TCA: '2024-01-01 12:00:00',
    SAT_1_ID: 25544,
    SAT_1_NAME: 'ISS (ZARYA)',
    SAT_2_ID: 47311,
    SAT_2_NAME: 'COSMOS 2251 DEB',
    MIN_RNG: 0.083,
    PC: 0.000856,
    RELATIVE_SPEED: 14.23,
  });
  const [event] = conjunctionsFromCdm([message], entries, 10);
  const card = createConjunctionDetailEntry(event, { x: 0 }, (text) => text);
  assert.equal(card.title, 'ISS (ZARYA) × COSMOS 2251 DEB');
  assert.equal(card.selected, true);
  assert.deepEqual(card.details, [
    'NORAD 25544 × 47311',
    'Pc 8.56e-4',
    'TCA 2024-01-01 12:00Z',
    'Relative speed 14.23 km/s',
    'Source Space-Track CDM',
  ]);

  // A CDM that omits a number is not a zero: the line says so instead.
  const bare = createConjunctionDetailEntry(
    { ...event, pc: null, relativeSpeedKmS: null, secondaryNorad: '' },
    { x: 0 },
    (text) => text,
  );
  assert.deepEqual(bare.details.slice(0, 2), ['NORAD 25544', 'Pc Unavailable']);
  assert.equal(bare.details[3], 'Relative speed Unavailable');
});

test('a missing relative speed is propagated from both element sets', () => {
  const entries = [...parseTleCatalog(ISS), ...parseTleCatalog(DEBRIS)];
  const withoutSpeed = parseCdmMessage({
    CDM_ID: 7,
    TCA: '2024-01-01 12:00:00',
    SAT_1_ID: 25544,
    SAT_1_NAME: 'ISS (ZARYA)',
    SAT_2_ID: 47311,
    SAT_2_NAME: 'COSMOS 2251 DEB',
    MIN_RNG: 0.2,
    PC: 0.0002,
  });
  assert.equal(withoutSpeed.relativeSpeedKmS, null, 'the feed sent none');

  const [event] = conjunctionsFromCdm([withoutSpeed], entries, 10);
  assert.equal(event.relativeSpeedSource, 'elements');
  assert.ok(Number.isFinite(event.relativeSpeedKmS));
  // Two low-Earth orbits on different planes close at a few km/s — never zero,
  // never a re-entry speed.
  assert.ok(event.relativeSpeedKmS > 0.1 && event.relativeSpeedKmS < 16);

  const card = createConjunctionDetailEntry(event, { x: 0 }, (text) => text);
  assert.match(
    card.details[3],
    /^Relative speed \d+\.\d\d km\/s \(computed\)$/,
    'a propagated number says so',
  );

  // The feed's own figure wins when it has one, and is not marked computed.
  const reported = parseCdmMessage({
    CDM_ID: 8,
    TCA: '2024-01-01 12:00:00',
    SAT_1_ID: 25544,
    SAT_1_NAME: 'ISS (ZARYA)',
    SAT_2_ID: 47311,
    SAT_2_NAME: 'COSMOS 2251 DEB',
    RELATIVE_SPEED: 14.23,
  });
  const [fromFeed] = conjunctionsFromCdm([reported], entries, 10);
  assert.equal(fromFeed.relativeSpeedSource, 'cdm');
  assert.equal(fromFeed.relativeSpeedKmS, 14.23);

  // A secondary with no element set cannot be propagated: the card says so
  // rather than inventing a speed.
  const unknownSecondary = parseCdmMessage({
    CDM_ID: 9,
    TCA: '2024-01-01 12:00:00',
    SAT_1_ID: 25544,
    SAT_1_NAME: 'ISS (ZARYA)',
    SAT_2_ID: 99999,
    SAT_2_NAME: 'UNKNOWN',
  });
  const [bare] = conjunctionsFromCdm([unknownSecondary], entries, 10);
  assert.equal(bare.relativeSpeedKmS, null);
  assert.equal(bare.relativeSpeedSource, null);
  const bareCard = createConjunctionDetailEntry(bare, { x: 0 }, (text) => text);
  assert.equal(bareCard.details[3], 'Relative speed Unavailable');
});

test('only the missing half of a pair is fetched, with the right numbers', () => {
  const entries = parseTleCatalog(ISS);
  const missing = parseCdmMessage({
    CDM_ID: 21,
    TCA: '2024-01-01 12:00:00',
    SAT_1_ID: 25544,
    SAT_1_NAME: 'ISS (ZARYA)',
    SAT_2_ID: 6121,
    SAT_2_NAME: 'TEST OBJECT',
    MIN_RNG: 0.5,
  });
  assert.deepEqual(missingSecondaryNorads(entries, [missing]), ['6121']);

  // The feed's own speed needs no element set at all.
  const reported = { ...missing, relativeSpeedKmS: 14.23 };
  assert.deepEqual(missingSecondaryNorads(entries, [reported]), []);

  // An event whose primary is unknown cannot be placed, so fetching its
  // secondary would be a wasted request.
  const orphan = { ...missing, primaryId: '99999' };
  assert.deepEqual(missingSecondaryNorads(entries, [orphan]), []);

  // One read per object, however many events name it.
  const repeated = [missing, { ...missing, id: 'cdm:22' }];
  assert.deepEqual(missingSecondaryNorads(entries, repeated), ['6121']);
  assert.deepEqual(missingSecondaryNorads(entries, repeated, 0), []);
});

test('a zero-padded catalogue number still finds its element set', () => {
  // The live feed: GP says "06121", the CDM says "6121". A plain string
  // lookup found neither, so every conjunction below 10 000 was dropped.
  const padded = [
    'TEST OBJECT',
    '1 06121U 72058A   24001.50000000  .00000100  00000-0  10000-3 0  9991',
    '2 06121  74.0500  12.3456 0012345 100.0000 260.0000 14.90000000  1234',
  ].join('\n');
  const entries = parseTleCatalog(padded);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].norad, '06121');
  assert.equal(noradKey('06121'), '6121');
  assert.equal(noradKey(6121), '6121');
  assert.equal(noradKey('00005'), '5');

  const message = parseCdmMessage({
    CDM_ID: 11,
    TCA: '2024-01-01 12:00:00',
    SAT_1_ID: 6121,
    SAT_1_NAME: 'TEST OBJECT',
    SAT_2_ID: 25544,
    SAT_2_NAME: 'ISS (ZARYA)',
    MIN_RNG: 1.2,
  });
  const placed = conjunctionsFromCdm([message], entries, 10);
  assert.equal(placed.length, 1, 'the padded set is found');
  assert.equal(placed[0].norad, '06121');
});
test('a relative speed reads both element sets and refuses garbage', () => {
  const iss = parseTleCatalog(ISS)[0];
  const debris = parseTleCatalog(DEBRIS)[0];
  const speed = relativeSpeedAt(
    iss.line1,
    iss.line2,
    debris.line1,
    debris.line2,
    AT,
  );
  assert.ok(Number.isFinite(speed) && speed > 0);
  // The same object does not close on itself.
  const same = relativeSpeedAt(iss.line1, iss.line2, iss.line1, iss.line2, AT);
  assert.ok(same < 1e-9);
  // A set that cannot be read is an absence, not a zero.
  assert.equal(
    relativeSpeedAt(iss.line1, iss.line2, 'garbage', 'garbage', AT),
    null,
  );
});

test('a collision probability keeps the exponent the feed reported', () => {
  assert.equal(formatCollisionProbability(0.000856), '8.56e-4');
  assert.equal(formatCollisionProbability('0.0000012'), '1.20e-6');
  assert.equal(formatCollisionProbability(0), '0');
  assert.equal(formatCollisionProbability(null), '');
  assert.equal(formatCollisionProbability(undefined), '');
  assert.equal(formatCollisionProbability('n/a'), '');
});

test('the caps keep a phone in budget', () => {
  assert.ok(WATCH_SOURCE_CAPS.azmth <= 1000);
  assert.ok(WATCH_SOURCE_CAPS['war-monitor'] <= 200);
  assert.ok(WATCH_SOURCE_CAPS['orbital-radar'] <= 24);
});
