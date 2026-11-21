import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SITE_COOLDOWN_MS,
  pickInspectionSite,
  siteKey,
} from './patrol.js';

const NOW = 1_700_000_000_000;

const rows = [
  // A close pair, then a far one: the near site is always the same address.
  { latitude: 48.85, longitude: 2.35 },
  { latitude: 48.9, longitude: 2.4 },
  { latitude: 35.68, longitude: 139.76 },
];

test('the nearest unvisited site wins, not just the nearest site', () => {
  const from = { latDeg: 48.86, lonDeg: 2.35 };
  const first = pickInspectionSite(rows, { from, now: NOW, visitedSites: {} });
  assert.deepEqual(
    [first.latDeg, first.lonDeg],
    [48.85, 2.35],
    'the closest record is inspected first',
  );

  const second = pickInspectionSite(rows, {
    from,
    now: NOW + 60_000,
    visitedSites: { [first.key]: NOW },
  });
  assert.notEqual(
    second.key,
    first.key,
    'a site visited one minute ago is not picked again',
  );
});

test('a cooling catalog rotates through its sites, oldest first', () => {
  const from = { latDeg: 48.86, lonDeg: 2.35 };
  const recent = NOW - 1_000;
  const old = NOW - SITE_COOLDOWN_MS + 5_000;
  const site = pickInspectionSite(rows, {
    from,
    now: NOW,
    visitedSites: {
      [siteKey(48.85, 2.35)]: recent,
      [siteKey(48.9, 2.4)]: old,
      [siteKey(35.68, 139.76)]: recent,
    },
  });
  assert.deepEqual(
    [site.latDeg, site.lonDeg],
    [48.9, 2.4],
    'when every site is cooling, the longest-unvisited one is inspected',
  );
  assert.equal(site.cooldown, true);
});

test('a site past its cooldown is fresh again', () => {
  const site = pickInspectionSite([{ latitude: 48.85, longitude: 2.35 }], {
    from: { latDeg: 0, lonDeg: 0 },
    now: NOW,
    visitedSites: { [siteKey(48.85, 2.35)]: NOW - SITE_COOLDOWN_MS - 1 },
  });
  assert.equal(site.cooldown, false);
});

test('the site key rounds the same place together and ignores bad rows', () => {
  assert.equal(siteKey(48.8501, 2.3499), siteKey(48.85, 2.35));
  assert.notEqual(siteKey(48.85, 2.35), siteKey(48.86, 2.35));
  assert.equal(siteKey(Number.NaN, 2.35), '');
  assert.equal(
    pickInspectionSite(
      [
        { latitude: null, longitude: 2.35 },
        { latitude: 48.85, longitude: undefined },
      ],
      { from: { latDeg: 0, lonDeg: 0 }, now: NOW },
    ),
    null,
    'positionless rows never produce a target',
  );
});

test('ties break on the site key, so a pass is reproducible', () => {
  const tie = [
    { latitude: 10, longitude: 0 },
    { latitude: 0, longitude: 10 },
  ];
  const first = pickInspectionSite(tie, {
    from: { latDeg: 0, lonDeg: 0 },
    now: NOW,
  });
  const again = pickInspectionSite(tie, {
    from: { latDeg: 0, lonDeg: 0 },
    now: NOW,
  });
  assert.equal(first.key, again.key);
  assert.equal(first.key, '0.00,10.00', 'the lexicographically first key wins');
});
