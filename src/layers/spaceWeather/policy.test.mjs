import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALERT_ENTITY_ID,
  alertColor,
  auroraAlpha,
  buildAlertCard,
  buildFlareCard,
  createAlertOverlayEntry,
  createFlareOverlayEntry,
  createSelectedCardEntry,
  flareColor,
  flareEntityId,
  flareIdFromPick,
  flarePixelSize,
  formatLatLon,
  formatUtcTime,
  isAlertPick,
  selectLabelCohort,
} from './policy.js';

const FLARE = {
  id: 'flare-2026-10-30T13:08:00.000Z',
  beginTime: Date.UTC(2026, 9, 30, 13, 8),
  maxTime: Date.UTC(2026, 9, 30, 13, 22),
  endTime: null,
  beginClass: 'B2.5',
  maxClass: 'X1.2',
  active: true,
  subsolar: { lat: -21.4, lon: -162.2 },
};

const SUMMARY = {
  grade: 1,
  code: 'G1',
  kp: 5.3,
  strongestFlare: { ...FLARE, maxClass: 'M4.1' },
  auroraPeak: { lon: 119, lat: 71, probability: 22 },
};

test('the flare fiche names the class, the span and the drawn point', () => {
  const card = buildFlareCard(FLARE);
  assert.equal(card.title, 'X1.2 · solar flare');
  assert.ok(card.details.includes('GOES X-ray flare'));
  assert.ok(
    card.details.some((line) =>
      line.includes('Begin 13:08 UTC') && line.includes('Peak 13:22 UTC'),
    ),
    card.details.join(' | '),
  );
  assert.ok(card.details.some((line) => line.endsWith('in progress')));
  assert.ok(
    card.details.includes('Subsolar impact 21°S 162°W'),
    'a flare is placed by its subsolar point, and the card says so',
  );
  assert.ok(card.details.at(-1).startsWith('NOAA SWPC'));
});

test('the geomagnetic fiche reads the G level off the K index', () => {
  const card = buildAlertCard(SUMMARY);
  assert.equal(card.title, 'G1 · Kp 5.3');
  assert.equal(card.details[0], 'Geomagnetic storm G1');
  assert.ok(card.details.includes('Planetary K index · Kp 5.3'));
  assert.ok(card.details.includes('Aurora 22% · 71°N 119°E'));
  assert.ok(card.details.includes('Strongest flare (24 h) M4.1'));

  const quiet = buildAlertCard({ grade: 0, code: 'G0', kp: 1.7 });
  assert.equal(quiet.title, 'G0 · Kp 1.7');
  assert.equal(quiet.details[0], 'Quiet field · no storm');
  const unknown = buildAlertCard({ grade: 0, code: 'G0', kp: null });
  assert.ok(unknown.details.includes('Planetary K index · K index unavailable'));
});

test('accents and sizes follow the class and the G grade', () => {
  assert.equal(flareColor({ maxClass: 'X9.0' }), '#FF4D6D');
  assert.equal(flareColor({ maxClass: 'M1.0' }), '#FF9F45');
  assert.equal(flareColor({ maxClass: '?' }), '#A5D8FF');
  assert.ok(flarePixelSize({ maxClass: 'X5.0' }) > flarePixelSize({ maxClass: 'B1.0' }));
  assert.equal(alertColor(0), '#8B99A6');
  assert.equal(alertColor(5), '#B5179E');
  assert.equal(alertColor(99), '#B5179E');
  assert.ok(auroraAlpha(80) > auroraAlpha(10));
  assert.equal(auroraAlpha(null), 0.18);
});

test('the flare marker id round-trips and never claims another layer', () => {
  const id = flareEntityId(FLARE.id);
  assert.equal(flareIdFromPick(id), FLARE.id);
  assert.equal(flareIdFromPick(ALERT_ENTITY_ID), null);
  assert.equal(flareIdFromPick('earthquake:us7000'), null);
  assert.equal(isAlertPick(ALERT_ENTITY_ID), true);
  assert.equal(isAlertPick(flareEntityId(FLARE.id)), false);
});

test('the alert label outranks every flare, whatever the cohort cap', () => {
  const entries = [
    createFlareOverlayEntry(FLARE, { x: 0, y: 0, z: 0 }),
    createAlertOverlayEntry(SUMMARY, { x: 1, y: 0, z: 0 }),
  ];
  const cohort = selectLabelCohort(entries, 1);
  assert.equal(cohort.length, 1);
  assert.equal(cohort[0].id, 'alert');
  assert.equal(cohort[0].title, 'G1 · Kp 5.3');
  assert.equal(cohort[0].accent, alertColor(1));
  assert.deepEqual(selectLabelCohort(entries, 0), []);
});

test('a selected card needs a title, and keeps its fiche details', () => {
  const card = createSelectedCardEntry(
    'alert',
    { x: 0, y: 0, z: 0 },
    buildFlareCard(FLARE),
    '#FF4D6D',
  );
  assert.equal(card.variant, 'selected');
  assert.equal(card.protected, true);
  assert.equal(card.accent, '#FF4D6D');
  assert.ok(card.details.length > 0);
  assert.equal(createSelectedCardEntry('x', { x: 0, y: 0, z: 0 }, { title: '' }), null);
});

test('times and coordinates read without a sign to misread', () => {
  assert.equal(formatUtcTime(Date.UTC(2026, 9, 30, 7, 5)), '07:05 UTC');
  assert.equal(formatUtcTime(null), '');
  assert.equal(formatLatLon(71.4, 119.2), '71°N 119°E');
  assert.equal(formatLatLon(-21.4, -162.2), '21°S 162°W');
  assert.equal(formatLatLon(null, 3), '');
});
