import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ZONE_WATCH_LIMITS,
  ZoneWatch,
  collectZoneContacts,
  isStationary,
  toContact,
} from './zoneWatch.js';
import { ZONE_RULE_KINDS, validateZoneRule } from './zoneRules.js';

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const at = (minutes) => NOW + minutes * 60 * 1000;

/**
 * A 5 km ring off Antibes; `inside`/`outside` are comfortably on either side.
 * `id` is passed to the validator rather than written into the rule.
 */
const rule = ({ id, ...overrides } = {}) => {
  const result = validateZoneRule(
    {
      name: 'Marina',
      kind: ZONE_RULE_KINDS.entry,
      centre: { lat: 43.29, lon: 5.37 },
      radiusKm: 5,
      watch: { icao24: '', mmsi: '' },
      ...overrides,
    },
    { id },
  );
  assert.equal(result.ok, true, 'the test fixture must be a valid rule');
  return result.rule;
};

const INSIDE = { lat: 43.3, lon: 5.37 };
const OUTSIDE = { lat: 43.5, lon: 5.37 };

const aircraft = (overrides = {}) => ({
  icao24: 'abc123',
  callsign: 'TEST123',
  speedMps: 220,
  onGround: false,
  military: false,
  ...INSIDE,
  ...overrides,
});

const vessel = (overrides = {}) => ({
  mmsi: '227006010',
  name: 'FERRY ONE',
  speedKts: 12,
  ...INSIDE,
  ...overrides,
});

const watch = (limits) => new ZoneWatch({ now: () => NOW, limits });

test('a contact first seen inside is an entry, reported once', () => {
  const zone = watch();
  const rules = [rule()];

  const first = zone.update({ flights: [aircraft()] }, rules, NOW);
  assert.equal(first.length, 1);
  const [entry] = first;
  assert.equal(entry.kind, 'zone-entry');
  assert.equal(
    entry.severity,
    'warning',
    'nothing is listed, so nothing is critical',
  );
  assert.equal(entry.layerId, 'flights');
  assert.equal(entry.lat, INSIDE.lat);
  assert.equal(entry.atMs, NOW);
  assert.equal(entry.title.key, 'Zone entry — {contact}');
  assert.deepEqual(entry.title.params, {
    contact: 'TEST123',
    zone: 'Marina',
    identifier: 'ABC123',
  });
  assert.equal(entry.detail.key, 'Entered {zone} · {identifier}');
  assert.match(entry.id, /^zone:zone-1:entry:aircraft:ABC123:/);

  assert.deepEqual(
    zone.update({ flights: [aircraft()] }, rules, at(1)),
    [],
    'staying inside is not a second entry',
  );
});

test('nothing outside the ring, nothing without a rule', () => {
  const zone = watch();
  assert.deepEqual(
    zone.update({ flights: [aircraft(OUTSIDE)] }, [rule()], NOW),
    [],
  );
  assert.deepEqual(zone.update({ flights: [aircraft()] }, [], NOW), []);
});

test('the first scan is an entry too, so a rule added around traffic fires', () => {
  const zone = watch();
  const inside = aircraft();
  assert.deepEqual(zone.update({ flights: [inside] }, [], NOW), []);
  assert.equal(zone.update({ flights: [inside] }, [rule()], at(1)).length, 1);
});

test('an exit needs the contact seen outside, and a re-entry is a new alert', () => {
  const zone = watch();
  const entryRule = rule({ id: 'zone-entry' });
  const exitRule = rule({ id: 'zone-exit', kind: ZONE_RULE_KINDS.exit });

  const [first] = zone.update({ flights: [aircraft()] }, [entryRule], NOW);
  assert.equal(first.kind, 'zone-entry');
  assert.deepEqual(
    zone.update({ flights: [aircraft()] }, [exitRule], at(1)),
    [],
    'the first sighting is not an exit, however it entered the state',
  );

  const [exit] = zone.update(
    { flights: [aircraft(OUTSIDE)] },
    [exitRule],
    at(2),
  );
  assert.equal(exit.kind, 'zone-exit');
  assert.equal(exit.detail.key, 'Left {zone} · {identifier}');
  assert.deepEqual(
    zone.update({ flights: [aircraft(OUTSIDE)] }, [exitRule], at(3)),
    [],
    'staying outside is not a second exit',
  );
  assert.deepEqual(
    zone.update({ flights: [aircraft(OUTSIDE)] }, [entryRule], at(4)),
    [],
    'an entry rule never reports an exit',
  );

  const [reentry] = zone.update({ flights: [aircraft()] }, [entryRule], at(5));
  assert.equal(reentry.kind, 'zone-entry');
  assert.notEqual(reentry.id, first.id, 'a later arrival is its own alert');
  assert.match(reentry.id, new RegExp(`:${at(5)}$`));
});

test('a contact that goes silent is not an exit, and returns as an arrival', () => {
  const zone = watch();
  const rules = [rule({ kind: ZONE_RULE_KINDS.exit })];

  zone.update({ flights: [aircraft()] }, rules, NOW);
  assert.deepEqual(
    zone.update({ flights: [] }, rules, at(1)),
    [],
    'silence past one scan is a feed gap, not a departure',
  );
  assert.equal(zone.size, 1, 'the membership survives the grace period');

  // Still silent, past the grace period: the membership is dropped, with no
  // incident — the app never saw the aircraft outside the ring.
  zone.update({ flights: [] }, rules, at(5));
  assert.equal(zone.size, 0);

  // Back inside after the drop: the app cannot know it stayed, so it arrives.
  const back = zone.update({ flights: [aircraft()] }, [rule()], at(6));
  assert.equal(back.length, 1);
  assert.equal(back[0].kind, 'zone-entry');
});

test('parking needs a real dwell, inside and stationary', () => {
  const limits = { ...ZONE_WATCH_LIMITS, parkingDwellMs: 10 * 60 * 1000 };
  const zone = watch(limits);
  const rules = [rule({ kind: ZONE_RULE_KINDS.parking })];
  const parkedAircraft = aircraft({ speedMps: 0, onGround: false });

  assert.deepEqual(zone.update({ flights: [parkedAircraft] }, rules, NOW), []);
  assert.deepEqual(
    zone.update({ flights: [parkedAircraft] }, rules, at(9)),
    [],
    'nine minutes is not a stay yet',
  );

  const [parked] = zone.update({ flights: [parkedAircraft] }, rules, at(10));
  assert.equal(parked.kind, 'zone-parking');
  assert.equal(parked.title.key, 'Parked in {zone} — {contact}');
  assert.equal(parked.detail.key, 'Stationary {minutes} min · {identifier}');
  assert.equal(parked.detail.params.minutes, 10);

  assert.deepEqual(
    zone.update({ flights: [parkedAircraft] }, rules, at(20)),
    [],
    'one alert per stay',
  );

  // Moving breaks the stay; parking again later is a second alert.
  zone.update({ flights: [aircraft()] }, rules, at(21));
  zone.update({ flights: [parkedAircraft] }, rules, at(22));
  const second = zone.update({ flights: [parkedAircraft] }, rules, at(33));
  assert.equal(second.length, 1);
  assert.equal(second[0].detail.params.minutes, 11);
  assert.notEqual(second[0].id, parked.id);
});

test('a contact leaving the ring restarts the stay', () => {
  const limits = { ...ZONE_WATCH_LIMITS, parkingDwellMs: 10 * 60 * 1000 };
  const zone = watch(limits);
  const rules = [rule({ kind: ZONE_RULE_KINDS.parking })];
  const parkedVessel = vessel({ speedKts: 0 });

  zone.update({ vessels: [parkedVessel] }, rules, NOW);
  zone.update({ vessels: [vessel()] }, rules, at(5));
  assert.deepEqual(
    zone.update({ vessels: [parkedVessel] }, rules, at(16)),
    [],
    'the still-watch restarted when it left',
  );
  assert.equal(
    zone.update({ vessels: [parkedVessel] }, rules, at(26)).length,
    1,
  );
});

test('a speed nobody reported is not evidence of parking', () => {
  const zone = watch({ ...ZONE_WATCH_LIMITS, parkingDwellMs: 0 });
  const rules = [rule({ kind: ZONE_RULE_KINDS.parking })];

  assert.deepEqual(
    zone.update({ flights: [aircraft({ speedMps: null })] }, rules, NOW),
    [],
  );
  assert.deepEqual(
    zone.update({ vessels: [vessel({ speedKts: null })] }, rules, at(1)),
    [],
  );
  // Airborne with no speed, but the feed says it is on the ground.
  assert.equal(
    zone.update(
      { flights: [aircraft({ speedMps: null, onGround: true })] },
      rules,
      at(2),
    ).length,
    1,
  );
});

test('stationarity is judged per channel, with its own threshold', () => {
  const limits = ZONE_WATCH_LIMITS;
  assert.equal(
    isStationary(toContact(aircraft({ speedMps: 0 }), 'aircraft'), limits),
    true,
  );
  assert.equal(
    isStationary(toContact(aircraft({ speedMps: 40 }), 'aircraft'), limits),
    false,
  );
  assert.equal(
    isStationary(
      toContact(aircraft({ speedMps: null, onGround: true }), 'aircraft'),
      limits,
    ),
    true,
  );
  assert.equal(
    isStationary(toContact(vessel({ speedKts: 0.4 }), 'vessel'), limits),
    true,
  );
  assert.equal(
    isStationary(toContact(vessel({ speedKts: 3 }), 'vessel'), limits),
    false,
  );
});

test('a listed identifier is critical, an unlisted contact is a warning', () => {
  const zone = watch();
  const rules = [rule({ watch: { icao24: 'abc123', mmsi: '227006010' } })];

  const [listed] = zone.update({ flights: [aircraft()] }, rules, NOW);
  assert.equal(listed.severity, 'critical');
  const [other] = zone.update(
    { flights: [aircraft({ icao24: '4ca123' })] },
    rules,
    at(1),
  );
  assert.equal(other.severity, 'warning');
  const [ship] = zone.update({ vessels: [vessel()] }, rules, at(2));
  assert.equal(ship.severity, 'critical', 'the same rule lists the MMSI');
  assert.equal(ship.layerId, 'ais-live-vessels');
});

test('a military contact reports under the military layer', () => {
  const zone = watch();
  const [incident] = zone.update(
    { military: [aircraft({ military: true })] },
    [rule()],
    NOW,
  );
  assert.equal(incident.layerId, 'military');
  assert.equal(incident.title.params.contact, 'TEST123');
});

test('a disabled rule reports nothing and is not tracked', () => {
  const zone = watch();
  assert.deepEqual(
    zone.update({ flights: [aircraft()] }, [rule({ enabled: false })], NOW),
    [],
  );
  assert.equal(zone.size, 0);
});

test('a contact is judged once, even when two feeds carry it', () => {
  const zone = watch();
  const incidents = zone.update(
    { flights: [aircraft()], military: [aircraft({ military: true })] },
    [rule()],
    NOW,
  );
  assert.equal(incidents.length, 1, 'flights wins, the duplicate is dropped');
  assert.equal(incidents[0].layerId, 'flights');
});

test('records without an identifier or a position are ignored', () => {
  const contacts = collectZoneContacts({
    flights: [
      aircraft({ icao24: null }),
      aircraft({ icao24: 'nope' }),
      aircraft({ lat: null }),
      aircraft({ lat: 91 }),
      aircraft(),
    ],
    vessels: [vessel({ mmsi: '123' }), vessel()],
  });
  assert.deepEqual(
    contacts.map((contact) => contact.id),
    ['ABC123', '227006010'],
  );
  assert.equal(toContact(undefined, 'aircraft'), null);
  assert.equal(toContact(undefined, 'vessel'), null);
});

test('one rule watches its own circle, and several rules are independent', () => {
  const zone = watch();
  const near = rule({ id: 'zone-near', name: 'Near' });
  const far = rule({
    id: 'zone-far',
    name: 'Far',
    centre: { lat: 48.85, lon: 2.35 },
  });

  const incidents = zone.update({ flights: [aircraft()] }, [near, far], NOW);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].title.params.zone, 'Near');
});

test('a scan reports at most the incident cap', () => {
  const zone = watch({ ...ZONE_WATCH_LIMITS, maxIncidents: 2 });
  const flights = Array.from({ length: 5 }, (_, index) =>
    aircraft({
      icao24: index.toString(16).padStart(6, '0'),
      callsign: `TEST${index}`,
    }),
  );
  assert.equal(zone.update({ flights }, [rule()], NOW).length, 2);
});

test('the contacts one scan collects are bounded', () => {
  const flights = Array.from({ length: 50 }, (_, index) =>
    aircraft({ icao24: index.toString(16).padStart(6, '0') }),
  );
  assert.equal(
    collectZoneContacts({ flights }, { maxContacts: 10 }).length,
    10,
  );
  assert.deepEqual(collectZoneContacts({}, {}), []);
});
