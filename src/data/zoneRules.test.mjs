import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ZONE_RULES_STORAGE_KEY,
  ZONE_RULE_KINDS,
  ZONE_RULE_LIMITS,
  isWatched,
  nextZoneRuleId,
  normalizeIcao24,
  normalizeMmsi,
  normalizeStoredRules,
  parseWatchIdentifiers,
  parseWatchList,
  readStoredRules,
  validateZoneRule,
  watchesEverything,
  writeStoredRules,
  zoneContainsPoint,
  zoneDistanceKm,
} from './zoneRules.js';

/** A Storage-shaped fake, so the real read/write paths are exercised. */
const fakeStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    entries: () => map,
  };
};

const input = (overrides = {}) => ({
  name: 'Marina',
  kind: ZONE_RULE_KINDS.entry,
  centre: { lat: 43.29, lon: 5.37 },
  radiusKm: 5,
  watch: { icao24: '', mmsi: '' },
  ...overrides,
});

test('identifiers are normalised per channel, and only real ones pass', () => {
  assert.equal(normalizeIcao24(' 3c4b26 '), '3C4B26');
  assert.equal(
    normalizeIcao24('0x3c4b26'),
    '3C4B26',
    'a 0x prefix is tolerated',
  );
  assert.equal(
    normalizeIcao24('3c4b2'),
    null,
    'five hex digits is not an address',
  );
  assert.equal(normalizeIcao24('zzzzzz'), null);
  assert.equal(normalizeMmsi('227 006 010'), '227006010');
  assert.equal(normalizeMmsi('227-006-010'), '227006010');
  assert.equal(normalizeMmsi('22700601'), null, 'eight digits is not an MMSI');
});

test('a watch list keeps the typed order, folds case and reports what it refused', () => {
  const { ids, rejected } = parseWatchList(
    '3c4b26, 3C4B26\n4ca123 ; not-an-id 227006010',
    'icao24',
  );
  assert.deepEqual(ids, ['3C4B26', '4CA123'], 'duplicates fold together');
  assert.deepEqual(rejected, ['not-an-id', '227006010']);
});

test('a watch list is bounded, so one paste cannot grow the scan', () => {
  const many = Array.from({ length: 80 }, (_, index) =>
    index.toString(16).padStart(6, '0'),
  ).join(' ');
  const { ids } = parseWatchList(many, 'icao24');
  assert.equal(ids.length, ZONE_RULE_LIMITS.maxWatchIds);
});

test('an empty watch list watches every contact, a listed one does not', () => {
  const open = validateZoneRule(input());
  assert.equal(open.ok, true);
  assert.equal(watchesEverything(open.rule), true);
  assert.equal(isWatched(open.rule, 'icao24', '3C4B26'), false);

  const listed = validateZoneRule(
    input({ watch: { icao24: '3c4b26', mmsi: '227006010' } }),
  );
  assert.equal(listed.ok, true);
  assert.equal(watchesEverything(listed.rule), false);
  assert.equal(isWatched(listed.rule, 'icao24', '3c4b26'), true);
  assert.equal(isWatched(listed.rule, 'mmsi', '227006010'), true);
  assert.equal(isWatched(listed.rule, 'mmsi', '227006011'), false);
});

test('one field is split by shape, and what is refused is reported', () => {
  const split = parseWatchIdentifiers('3c4b26 227006010\nnope 227006010');
  assert.deepEqual(split.icao24, ['3C4B26']);
  assert.deepEqual(split.mmsi, ['227006010'], 'a repeated MMSI is kept once');
  assert.deepEqual(split.rejected, ['nope']);

  const result = validateZoneRule(input({ name: 'Port', watch: split }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.rule.watch, {
    icao24: ['3C4B26'],
    mmsi: ['227006010'],
  });
});

test('a rule takes a watch list as typed text or as the lists already split', () => {
  const typed = validateZoneRule(
    input({ watch: { icao24: '3c4b26', mmsi: '227006010' } }),
  ).rule;
  const split = validateZoneRule(
    input({ watch: parseWatchIdentifiers('3c4b26 227006010') }),
  ).rule;
  assert.deepEqual(typed.watch, split.watch);
});

test('every malformed rule is refused with a reason the panel can translate', () => {
  assert.deepEqual(validateZoneRule(input({ kind: 'loiter' })), {
    ok: false,
    reason: 'Pick what the zone should watch for',
  });
  assert.deepEqual(validateZoneRule(input({ name: '  ' })), {
    ok: false,
    reason: 'Name the zone',
  });
  assert.deepEqual(validateZoneRule(input({ centre: { lat: 91, lon: 0 } })), {
    ok: false,
    reason: 'The zone needs a position on the map',
  });
  assert.deepEqual(
    validateZoneRule(input({ centre: { lat: 'north', lon: 0 } })),
    { ok: false, reason: 'The zone needs a position on the map' },
  );
  assert.deepEqual(validateZoneRule(input({ radiusKm: 0 })), {
    ok: false,
    reason: 'The radius must be between {min} and {max} km',
  });
  assert.deepEqual(
    validateZoneRule(input({ radiusKm: ZONE_RULE_LIMITS.maxRadiusKm + 1 })),
    { ok: false, reason: 'The radius must be between {min} and {max} km' },
  );
});

test('a name is trimmed and bounded, and enabled defaults to on', () => {
  const long = 'x'.repeat(200);
  const result = validateZoneRule(input({ name: `  ${long}  ` }));
  assert.equal(result.rule.name.length, ZONE_RULE_LIMITS.maxNameLength);
  assert.equal(result.rule.enabled, true);
  assert.equal(validateZoneRule(input({ enabled: false })).rule.enabled, false);
});

test('a rule id is derived from the ids already in use', () => {
  assert.equal(nextZoneRuleId([]), 'zone-1');
  assert.equal(nextZoneRuleId([{ id: 'zone-1' }, { id: 'zone-7' }]), 'zone-8');
  assert.equal(nextZoneRuleId([{ id: 'custom' }]), 'zone-1');
});

test('the ring counts as inside, so a contact on it does not flicker', () => {
  const rule = validateZoneRule(input({ radiusKm: 5 })).rule;
  assert.equal(zoneContainsPoint(rule, { lat: 43.29, lon: 5.37 }), true);
  assert.equal(zoneContainsPoint(rule, { lat: 43.34, lon: 5.37 }), false);
  // Just inside and just outside a 5 km ring along the meridian.
  const near = zoneDistanceKm(rule, { lat: 43.33, lon: 5.37 });
  assert.ok(near < 5, `expected inside, measured ${near}`);
  const far = zoneDistanceKm(rule, { lat: 43.34, lon: 5.37 });
  assert.ok(far > 5, `expected outside, measured ${far}`);
  assert.equal(zoneContainsPoint(rule, { lat: 43.33, lon: 5.37 }), true);
  assert.equal(zoneContainsPoint(rule, { lat: 43.34, lon: 5.37 }), false);
});

test('an unusable rule or point is never inside', () => {
  const rule = validateZoneRule(input()).rule;
  assert.equal(zoneContainsPoint(rule, { lat: null, lon: 5 }), false);
  assert.equal(zoneContainsPoint(rule, { lat: 43.1, lon: 400 }), false);
  assert.equal(zoneDistanceKm({ centre: null }, { lat: 1, lon: 1 }), null);
  assert.equal(zoneDistanceKm(rule, { lat: 43.1, lon: 5.3 }) > 0, true);
});

test('stored rules survive a round trip and unusable entries are dropped', () => {
  const storage = fakeStorage();
  const first = validateZoneRule(input()).rule;
  const second = validateZoneRule(
    input({ name: 'Approach', kind: 'exit' }),
  ).rule;
  assert.equal(writeStoredRules(storage, [first, second]), true);
  assert.deepEqual(readStoredRules(storage), [first, second]);
});

test('storage holding something else is ignored rather than thrown', () => {
  assert.deepEqual(
    readStoredRules(fakeStorage({ [ZONE_RULES_STORAGE_KEY]: '{' })),
    [],
  );
  assert.deepEqual(
    readStoredRules(fakeStorage({ [ZONE_RULES_STORAGE_KEY]: '"a rule"' })),
    [],
  );
  assert.deepEqual(readStoredRules(undefined), []);
  assert.deepEqual(
    normalizeStoredRules([
      input(),
      { kind: 'entry' },
      null,
      input({ name: 'B' }),
    ]).map((rule) => rule.name),
    ['Marina', 'B'],
    'a hand-edited entry is dropped, the rest is kept',
  );
});

test('the stored rules are bounded, however many are written', () => {
  const many = Array.from(
    { length: ZONE_RULE_LIMITS.maxRules + 5 },
    (_, index) => validateZoneRule(input({ name: `Zone ${index}` })).rule,
  );
  assert.equal(normalizeStoredRules(many).length, ZONE_RULE_LIMITS.maxRules);
});

test('a storage that refuses the write leaves the session working', () => {
  const refusing = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
  assert.equal(
    writeStoredRules(refusing, [validateZoneRule(input()).rule]),
    false,
  );
  assert.equal(writeStoredRules(undefined, []), false);
});
