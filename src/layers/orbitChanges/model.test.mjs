import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORBIT_CHANGE_THRESHOLDS,
  baselineFromCatalog,
  orbitChangeAccent,
  orbitalChanges,
  parseTleCatalog,
  semiMajorAxisKm,
  tleEpochMs,
} from './model.js';

const FIXTURE = [
  'ISS (ZARYA)',
  '1 25544U 98067A   24001.50000000  .00016717  00000+0  30777-3 0  9993',
  '2 25544  51.6416  90.5085 0004526  90.7038  51.2835 15.49512600  1234',
  'NOAA 20',
  '1 43013U 17073A   24001.50000000  .00000123  00000+0  10245-4 0  9994',
  '2 43013  98.7200 120.1000 0001200  90.0000 270.0000 14.19512300  1234',
].join('\n');

const clone = (value) => JSON.parse(JSON.stringify(value));

test('parses element sets and their epochs', () => {
  const entries = parseTleCatalog(FIXTURE);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].norad, '25544');
  assert.equal(entries[0].name, 'ISS (ZARYA)');
  assert.equal(entries[1].norad, '43013');
  assert.ok(Math.abs(entries[0].elements.inclinationDeg - 51.6416) < 1e-6);
  assert.ok(Math.abs(entries[0].elements.meanMotion - 15.495126) < 1e-9);
  // 2024 day 1.5 = 2024-01-01T12:00:00Z
  assert.equal(tleEpochMs(entries[0].line1), Date.UTC(2024, 0, 1, 12));
});

test('the stored baseline drops the element lines', () => {
  const baseline = baselineFromCatalog(parseTleCatalog(FIXTURE), 42);
  assert.equal(baseline.at, 42);
  const stored = baseline.objects['25544'];
  assert.equal(stored.line1, undefined);
  assert.equal(stored.line2, undefined);
  assert.equal(stored.epochMs, Date.UTC(2024, 0, 1, 12));
});

test('a raised orbit is reported, with the estimated cost', () => {
  const entries = parseTleCatalog(FIXTURE);
  const baseline = baselineFromCatalog(entries, 0);
  const next = clone(entries);
  // A one-part-in-a-thousand mean motion is about 4.5 km at ISS altitude.
  next[0].elements.meanMotion *= 0.999;
  next[0].epochMs += 3600_000;
  const events = orbitalChanges(baseline, next);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.norad, '25544');
  assert.ok(Math.abs(event.deltaAltitudeKm - 4.5) < 0.2);
  assert.ok(event.deltaVMps > 0);
  assert.ok(Number.isFinite(event.lat) && Number.isFinite(event.lon));
  assert.equal(event.previousEpoch, Date.UTC(2024, 0, 1, 12));
});

test('a plane change alone is reported', () => {
  const entries = parseTleCatalog(FIXTURE);
  const baseline = baselineFromCatalog(entries, 0);
  const next = clone(entries);
  next[1].elements.inclinationDeg += 0.05;
  next[1].epochMs += 3600_000;
  const events = orbitalChanges(baseline, next);
  assert.equal(events.length, 1);
  assert.equal(events[0].norad, '43013');
  assert.ok(events[0].deltaInclinationDeg > 0.04);
});

test('a refit below the thresholds is not a change', () => {
  const entries = parseTleCatalog(FIXTURE);
  const baseline = baselineFromCatalog(entries, 0);
  const next = clone(entries);
  // 0.9 km of altitude: under the 1.5 km threshold.
  next[0].elements.meanMotion *= 0.9998;
  next[0].epochMs += 3600_000;
  assert.equal(orbitalChanges(baseline, next).length, 0);
});

test('the same element set seen twice is not a change', () => {
  const entries = parseTleCatalog(FIXTURE);
  const baseline = baselineFromCatalog(entries, 0);
  assert.equal(orbitalChanges(baseline, entries).length, 0);
});

test('an object missing from either side is never reported', () => {
  const entries = parseTleCatalog(FIXTURE);
  const baseline = baselineFromCatalog(entries, 0);
  const onlyNew = clone(entries).slice(1);
  assert.equal(orbitalChanges(baseline, onlyNew).length, 0);
  assert.equal(orbitalChanges({ objects: {} }, entries).length, 0);
});

test('semi-major axis is the inverse of the mean motion', () => {
  // A geostationary mean motion is 1.0027 rev/day at 42 164 km.
  assert.ok(Math.abs(semiMajorAxisKm(1.0027) - 42164) < 120);
  assert.equal(semiMajorAxisKm(0), null);
});

test('the accent saturates on the large changes', () => {
  assert.equal(orbitChangeAccent(1), orbitChangeAccent(4.9));
  assert.notEqual(orbitChangeAccent(1), orbitChangeAccent(10));
  assert.equal(orbitChangeAccent(60), orbitChangeAccent(200));
  assert.ok(ORBIT_CHANGE_THRESHOLDS.altitudeKm > 0);
});
