import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WATCH_SOURCE_CAPS,
  WATCH_SOURCES,
  fromCatalogEntries,
  fromN2yoAbove,
  fromSpaceTrackGp,
  fromTleApiMembers,
  conjunctionsFromCdm,
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
  assert.equal(parseN2yoPayload({ error: 'Invalid API Key!' }).error, 'Invalid API Key!');
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

test('the caps keep a phone in budget', () => {
  assert.ok(WATCH_SOURCE_CAPS.azmth <= 1000);
  assert.ok(WATCH_SOURCE_CAPS['war-monitor'] <= 200);
  assert.ok(WATCH_SOURCE_CAPS['orbital-radar'] <= 24);
});
