import test from 'node:test';
import assert from 'node:assert/strict';

import { setLocale, t } from '../i18n/index.js';
import {
  DISMISS_TTL_MS,
  IncidentFeed,
  alertButtonLabel,
  announceText,
  incidentTimeText,
  localizeIncident,
} from './alertCenter.js';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const incident = (id, overrides = {}) => ({
  id,
  kind: 'earthquake',
  severity: 'warning',
  layerId: 'earthquakes',
  lat: 1,
  lon: 2,
  atMs: NOW - 60_000,
  title: { key: 'Earthquake M{magnitude}', params: { magnitude: 5.4 } },
  detail: { key: 'Depth {depth} km', params: { depth: 12 } },
  ...overrides,
});

test('an incident is new once, then only updated', () => {
  const feed = new IncidentFeed({ now: () => NOW });
  assert.deepEqual(
    feed.update([incident('a')], NOW).map((item) => item.id),
    ['a'],
  );
  assert.deepEqual(feed.update([incident('a')], NOW), []);
  assert.equal(feed.size, 1);
});

test('an incident disappears after the retention window', () => {
  const feed = new IncidentFeed({ now: () => NOW, retainMs: 60_000 });
  feed.update([incident('a')], NOW);
  feed.update([], NOW + 61_000);
  assert.equal(feed.size, 0);
});

test('a dismissed incident leaves the list and is remembered', () => {
  const feed = new IncidentFeed({ now: () => NOW });
  feed.update([incident('a'), incident('b')], NOW);
  feed.dismiss('a', NOW);
  assert.deepEqual(
    feed.items().map((item) => item.id),
    ['b'],
  );
  assert.equal(feed.isDismissed('a'), true);
  assert.deepEqual(feed.dismissedEntries(), [['a', NOW]]);
});

test('restored dismissals older than the TTL are dropped', () => {
  const feed = new IncidentFeed({ now: () => NOW });
  feed.restoreDismissals(
    [
      ['fresh', NOW - 1000],
      ['stale', NOW - DISMISS_TTL_MS - 1000],
    ],
    NOW,
  );
  feed.update([incident('fresh'), incident('stale')], NOW);
  assert.deepEqual(
    feed.items().map((item) => item.id),
    ['stale'],
  );
});

test('incident text is translated, params resolved, keys never shown', () => {
  setLocale('fr');
  try {
    const text = localizeIncident(
      incident('a', {
        statusKey: 'General emergency',
        title: {
          key: 'Aircraft emergency — {aircraft}',
          params: { aircraft: 'AFR123' },
        },
        detail: {
          key: 'Squawk {squawk} — {status}',
          params: {
            squawk: '7700',
            status: { messageKey: 'General emergency' },
          },
        },
      }),
    );
    assert.equal(text.title, 'Urgence aérienne — AFR123');
    assert.equal(text.detail, `Code 7700 — ${t('General emergency')}`);
    assert.ok(!text.detail.includes('{'));
  } finally {
    setLocale('en');
  }
});

test('the bell label carries the count', () => {
  setLocale('en');
  assert.equal(alertButtonLabel(0), 'Alerts');
  assert.equal(alertButtonLabel(3), 'Alerts: 3');
});

test('a burst is announced as a count, one arrival by its title', () => {
  setLocale('en');
  assert.equal(announceText([]), null);
  assert.equal(announceText([incident('a')]), 'Earthquake M5.4');
  assert.equal(
    announceText([incident('a'), incident('b'), incident('c')]),
    '3 new alerts',
  );
});

test('recent incidents read as relative time, older ones as a clock time', () => {
  setLocale('en');
  assert.match(incidentTimeText(NOW - 5 * 60_000, NOW), /5 minutes ago/);
  assert.equal(incidentTimeText(null, NOW), '');
  assert.doesNotMatch(incidentTimeText(NOW - 6 * 60 * 60_000, NOW), /ago/);
});
