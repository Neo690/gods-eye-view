import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AURORA_MAX_POINTS,
  flareClassScore,
  geomagneticLevel,
  normalizeAuroraGrid,
  normalizeFlareRecords,
  normalizeKpReading,
  normalizeKpSeries,
  normalizeSpaceWeatherSnapshot,
  parseFlareClass,
  parseUtcMs,
  summarizeSpaceWeather,
  wrapLongitude,
} from './records.js';

const NOW = Date.UTC(2026, 9, 30, 14, 0, 0);

test('a zone-less SWPC stamp is read as UTC, never as local time', () => {
  assert.equal(
    parseUtcMs('2026-10-30T07:26:00'),
    Date.UTC(2026, 9, 30, 7, 26, 0),
  );
  assert.equal(
    parseUtcMs('2026-10-30T13:25:00Z'),
    Date.UTC(2026, 9, 30, 13, 25, 0),
  );
  assert.equal(parseUtcMs('Unk'), null);
  assert.equal(parseUtcMs(''), null);
});

test('flare classes parse and order by letter then magnitude', () => {
  assert.deepEqual(parseFlareClass('X1.2'), {
    letter: 'X',
    magnitude: 1.2,
    rank: 4,
  });
  assert.equal(parseFlareClass('nope'), null);
  assert.ok(flareClassScore('X1.0') > flareClassScore('M9.9'));
  assert.ok(flareClassScore('M1.0') > flareClassScore('C9.9'));
  assert.equal(flareClassScore('?'), -1);
});

test('the flare log keeps the live window, newest first, and flags an unfinished burst', () => {
  const rows = [
    {
      begin_time: '2026-10-28T12:38:00Z',
      begin_class: 'B3.2',
      max_time: '2026-10-28T12:52:00Z',
      max_class: 'B6.4',
      end_time: '2026-10-28T13:03:00Z',
      current_class: 'B4.0',
      satellite: 18,
    },
    {
      begin_time: '2026-10-30T13:08:00Z',
      begin_class: 'B2.5',
      max_time: '2026-10-30T13:22:00Z',
      max_class: 'M2.7',
      end_time: 'Unk',
      current_class: 'M1.1',
      satellite: 18,
    },
  ];
  const flares = normalizeFlareRecords(rows, { now: NOW });
  assert.equal(flares.length, 1, 'the two-day-old burst is out of the window');
  const [flare] = flares;
  assert.equal(flare.maxClass, 'M2.7');
  assert.equal(flare.currentClass, 'M1.1');
  assert.equal(flare.active, true);
  assert.equal(flare.maxTime, Date.UTC(2026, 9, 30, 13, 22, 0));
  assert.match(flare.id, /^flare-2026-10-30T13:08:00\.000Z$/);
});

test('the current K index prefers the estimate the G scale is read against', () => {
  const reading = normalizeKpReading([
    { time_tag: '2026-10-30T07:26:00', kp_index: 1, estimated_kp: 1.33 },
  ]);
  assert.deepEqual(reading, {
    at: Date.UTC(2026, 9, 30, 7, 26, 0),
    kp: 1.33,
    observedKp: 1,
  });
  assert.equal(normalizeKpReading([]), null);
  assert.equal(normalizeKpReading([{ time_tag: '2026-10-30T07:26:00' }]), null);
});

test('the three-hourly series is chronological and capped from the tail', () => {
  const series = normalizeKpSeries(
    [
      { time_tag: '2026-10-23T03:00:00', Kp: 2 },
      { time_tag: '2026-10-23T00:00:00', Kp: 1.67 },
      { time_tag: '2026-10-23T06:00:00', Kp: 3 },
    ],
    2,
  );
  assert.deepEqual(
    series.map((row) => row.kp),
    [2, 3],
    'the newest readings survive the cap, oldest first',
  );
});

test('the G scale starts at Kp 5 and saturates at G5', () => {
  assert.deepEqual(geomagneticLevel(4.9), { grade: 0, code: 'G0', kp: 4.9 });
  assert.equal(geomagneticLevel(5).code, 'G1');
  assert.equal(geomagneticLevel(6.7).code, 'G2');
  assert.equal(geomagneticLevel(7).code, 'G3');
  assert.equal(geomagneticLevel(8.5).code, 'G4');
  assert.equal(geomagneticLevel(12).code, 'G5');
  assert.deepEqual(geomagneticLevel(null), { grade: 0, code: 'G0', kp: null });
});

test('the oval wraps SWPC longitudes, keeps its peak and decimates deterministically', () => {
  const payload = {
    'Observation Time': '2026-10-30T13:17:00Z',
    'Forecast Time': '2026-10-30T14:38:00Z',
    coordinates: [
      [0, -90, 3],
      [119, 71, 22],
      [240, 68, 12],
      [300, 70, 4],
    ],
  };
  const grid = normalizeAuroraGrid(payload);
  assert.deepEqual(grid.peak, { lon: 119, lat: 71, probability: 22 });
  assert.equal(grid.observedAt, Date.UTC(2026, 9, 30, 13, 17, 0));
  assert.deepEqual(
    grid.points.map(([lon]) => lon),
    [119, -120],
    '22% and 12% are drawn, 4% and 3% are below the threshold',
  );
  assert.equal(wrapLongitude(240), -120);
  // The antimeridian may land on either sign; both name the same meridian.
  assert.equal(Math.abs(wrapLongitude(180)), 180);

  const many = {
    coordinates: Array.from({ length: 100 }, (_, index) => [index, 70, 50]),
  };
  const capped = normalizeAuroraGrid(many, { maxPoints: 10 });
  assert.equal(capped.points.length, 10);
  const again = normalizeAuroraGrid(many, { maxPoints: 10 });
  assert.deepEqual(capped.points, again.points);
  assert.ok(AURORA_MAX_POINTS >= 100);
  assert.equal(normalizeAuroraGrid({}), null);
});

test('a malformed route answer is refused instead of blanking the globe', () => {
  assert.equal(normalizeSpaceWeatherSnapshot(null), null);
  assert.equal(normalizeSpaceWeatherSnapshot({}), null);
  const snapshot = normalizeSpaceWeatherSnapshot({
    fetchedAt: NOW,
    kp: { value: 5.3, at: NOW, observedKp: 5, series: [{ at: NOW, kp: 5 }] },
    flares: [{ id: 'flare-1', maxClass: 'M1.0' }, { id: null }],
    aurora: {
      points: [
        [10, 70, 40],
        ['x', 70, 40],
      ],
      peak: { lon: 10, lat: 70, probability: 40 },
    },
  });
  assert.equal(snapshot.flares.length, 1);
  assert.equal(snapshot.aurora.points.length, 1);
  assert.equal(snapshot.kp.value, 5.3);
});

test('the summary names the level and the strongest flare', () => {
  const summary = summarizeSpaceWeather({
    kp: { value: 6.1, at: NOW },
    flares: [
      { id: 'a', maxClass: 'C4.0', score: flareClassScore('C4.0'), maxTime: NOW },
      { id: 'b', maxClass: 'M2.7', score: flareClassScore('M2.7'), maxTime: NOW - 1 },
    ],
    aurora: { peak: { lon: 119, lat: 71, probability: 22 } },
  });
  assert.equal(summary.code, 'G2');
  assert.equal(summary.grade, 2);
  assert.equal(summary.strongestFlare.id, 'b');
  assert.deepEqual(summary.auroraPeak, { lon: 119, lat: 71, probability: 22 });
});
