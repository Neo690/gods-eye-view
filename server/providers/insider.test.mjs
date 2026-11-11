// server/providers/insider.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EDGAR_USER_AGENT,
  INSIDER_COUNT,
  INSIDER_ROUTE,
  buildInsiderUrl,
  insiderFailure,
} from './insider.js';

test('insider url asks EDGAR for ownership filings as atom', () => {
  const url = new URL(buildInsiderUrl());
  assert.equal(
    url.origin + url.pathname,
    'https://www.sec.gov/cgi-bin/browse-edgar',
  );
  assert.equal(url.searchParams.get('action'), 'getcurrent');
  assert.equal(url.searchParams.get('type'), '4');
  assert.equal(url.searchParams.get('owner'), 'include');
  assert.equal(url.searchParams.get('output'), 'atom');
  assert.equal(url.searchParams.get('count'), String(INSIDER_COUNT));
});

test('insider url clamps the count EDGAR accepts', () => {
  assert.equal(
    new URL(buildInsiderUrl({ count: 0 })).searchParams.get('count'),
    '1',
  );
  assert.equal(
    new URL(buildInsiderUrl({ count: 10_000 })).searchParams.get('count'),
    '400',
  );
});

test('route and defaults stay stable', () => {
  assert.equal(INSIDER_ROUTE, '/api/insider');
  assert.match(DEFAULT_EDGAR_USER_AGENT, /gods-eye-view/);
  assert.match(DEFAULT_EDGAR_USER_AGENT, /SEC_EDGAR_USER_AGENT/);
  assert.deepEqual(insiderFailure('upstream', { generatedAt: 1 }), {
    ok: false,
    rows: [],
    error: 'upstream',
    generatedAt: 1,
  });
});
