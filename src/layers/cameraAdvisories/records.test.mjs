import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVISORY_BANDS,
  advisoryHoverLines,
  advisoryListItems,
  failedAdvisorySources,
  normalizeAdvisoryPayload,
  severityColor,
  severityCounts,
  unqueriedBrands,
} from './records.js';

const match = (overrides = {}) => ({
  source: 'nvd',
  id: 'CVE-2024-0001',
  title: 'Axis Q6135-LE firmware allows remote code execution.',
  url: 'https://nvd.nist.gov/vuln/detail/CVE-2024-0001',
  published: '2024-01-02T00:00:00.000Z',
  score: 9.8,
  severity: 'critical',
  cves: ['CVE-2024-0001'],
  match: 'model',
  ...overrides,
});

const finding = (overrides = {}) => ({
  id: 'kc-1',
  name: 'I-90 at Elm',
  lat: 47.6,
  lon: -122.3,
  brand: 'axis',
  model: 'Q6135-LE',
  matches: [match()],
  worstSeverity: 'critical',
  worstScore: 9.8,
  ...overrides,
});

const payload = (overrides = {}) => ({
  generatedAt: '2026-11-06T10:00:00.000Z',
  cameras: {
    total: 4,
    identified: 2,
    brands: [
      { id: 'axis', cameras: 1, queried: true },
      { id: 'hikvision', cameras: 1, queried: false },
    ],
  },
  sources: [
    { id: 'cisa-csaf', ok: true, advisories: 1 },
    { id: 'nvd', ok: false, advisories: 0, error: 'nvd_unavailable' },
  ],
  counts: {
    flagged: 1,
    critical: 1,
    high: 0,
    medium: 0,
    low: 0,
    unscored: 0,
    advisories: 1,
    brandOnlyAdvisories: 3,
    truncated: false,
  },
  firmwareObserved: false,
  deviceContact: 'none',
  findings: [finding()],
  ...overrides,
});

test('a body that is not this route’s answer is refused whole', () => {
  assert.equal(normalizeAdvisoryPayload(null), null);
  assert.equal(normalizeAdvisoryPayload({ error: 'nope' }), null);
  assert.equal(normalizeAdvisoryPayload({ findings: 'x' }), null);
});

test('a finding without a position or a source is dropped, not moved', () => {
  const snapshot = normalizeAdvisoryPayload(
    payload({
      findings: [
        finding({ id: 'ok' }),
        finding({ id: 'no-lat', lat: undefined }),
        finding({ id: 'bad-lat', lat: 120 }),
        finding({ id: 'no-matches', matches: [] }),
        finding({ id: 'bad-match', matches: [{ id: '' }] }),
      ],
    }),
  );
  assert.deepEqual(
    snapshot.findings.map((entry) => entry.id),
    ['ok'],
  );
  assert.equal(snapshot.counts.critical, 1);
});

test('matches are worst-first even when the server sends them unordered', () => {
  const snapshot = normalizeAdvisoryPayload(
    payload({
      findings: [
        finding({
          matches: [
            match({ id: 'CVE-low', severity: 'low', score: 2.1 }),
            match({ id: 'CVE-critical', severity: 'critical', score: 9.8 }),
            match({ id: 'CVE-medium', severity: 'medium', score: 5 }),
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(
    snapshot.findings[0].matches.map((entry) => entry.id),
    ['CVE-critical', 'CVE-medium', 'CVE-low'],
  );
  assert.equal(snapshot.findings[0].worstSeverity, 'critical');
  assert.equal(snapshot.findings[0].worstScore, 9.8);
});

test('an unknown severity is unscored, not invisible', () => {
  const snapshot = normalizeAdvisoryPayload(
    payload({
      findings: [
        finding({
          matches: [match({ severity: 'urgent', score: null })],
        }),
      ],
    }),
  );
  assert.equal(snapshot.findings[0].worstSeverity, 'unscored');
  assert.equal(snapshot.counts.unscored, 1);
  assert.equal(severityColor('urgent'), '#8a94a6');
});

test('counts come from what is drawn, and the payload’s truncation is kept', () => {
  const snapshot = normalizeAdvisoryPayload(
    payload({
      findings: [
        finding({ id: 'a', worstSeverity: 'high', matches: [match({ severity: 'high', score: 8 })] }),
        finding({ id: 'b', worstSeverity: 'medium', matches: [match({ severity: 'medium', score: 5 })] }),
      ],
      counts: { ...payload().counts, truncated: true },
    }),
  );
  assert.deepEqual(severityCounts(snapshot.findings), {
    critical: 0,
    high: 1,
    medium: 1,
    low: 0,
    unscored: 0,
  });
  assert.equal(snapshot.counts.truncated, true);
  assert.equal(snapshot.counts.advisories, 1, 'the source counts still ride along');
});

test('the row list names the worst cameras and their advisory', () => {
  const items = advisoryListItems(
    [
      finding({ id: 'a', name: 'I-90 at Elm' }),
      finding({ id: 'b', name: '4th Ave', worstScore: 7, worstSeverity: 'high' }),
      finding({ id: 'c' }),
      finding({ id: 'd' }),
      finding({ id: 'e' }),
      finding({ id: 'f' }),
    ],
    5,
  );
  assert.equal(items.length, 5);
  assert.equal(items[0].lead, '9.8');
  assert.match(items[0].text, /I-90 at Elm/);
  assert.match(items[0].text, /axis Q6135-LE/);
  assert.match(items[0].text, /CVE-2024-0001/);
  assert.equal(items[0].accent, '#ff3b5c');
  assert.equal(advisoryListItems([finding()], 0).length, 0);
});

test('the hover tip carries the advisory, CVSS, CVEs and extra match count', () => {
  const lines = advisoryHoverLines(
    finding({
      matches: [
        match(),
        match({ id: 'CVE-2024-0002', severity: 'high', score: 7.2 }),
      ],
    }),
  );
  assert.equal(lines[0], 'I-90 at Elm');
  assert.equal(lines[1], 'axis Q6135-LE');
  assert.match(lines[2], /CVE-2024-0001 · CVSS 9\.8 \(\+1\)/);
  assert.equal(lines[3], 'CVE-2024-0001');
  assert.deepEqual(advisoryHoverLines({ matches: [] }), []);
});

test('failed sources and unqueried brands are surfaced, not swallowed', () => {
  const snapshot = normalizeAdvisoryPayload(payload());
  assert.deepEqual(failedAdvisorySources(snapshot), ['nvd']);
  assert.deepEqual(unqueriedBrands(snapshot), ['hikvision']);
  assert.equal(snapshot.deviceContact, 'none');
  assert.equal(snapshot.firmwareObserved, false);
  assert.equal(ADVISORY_BANDS.length, 5);
});
