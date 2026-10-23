import test from 'node:test';
import assert from 'node:assert/strict';

import {
  gnssAnchorFromSearch,
  gnssIntegrityResponse,
  inAndroidShell,
  installInAppApi,
} from './inAppApi.js';
import { GNSS_CLASSIFIER } from '../layers/gnss/records.js';

const NOW = Date.UTC(2026, 9, 23, 18, 0, 0);
const shell = {
  href: 'https://appassets.androidplatform.net/index.html',
  origin: 'https://appassets.androidplatform.net',
  hostname: 'appassets.androidplatform.net',
};
const snapshot = {
  now: NOW / 1000,
  ac: [
    {
      hex: 'abc123',
      type: 'adsb_icao',
      version: 2,
      alt_baro: 30000,
      lat: 30.2,
      lon: -97.7,
      nic: 5,
      nac_p: 6,
      seen_pos: 3,
    },
  ],
};
const okUpstream = async () =>
  new Response(JSON.stringify(snapshot), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

test('only the Android asset origin counts as the shell', () => {
  assert.equal(inAndroidShell(shell), true);
  assert.equal(
    inAndroidShell({ hostname: 'localhost', origin: 'http://localhost:4173' }),
    false,
  );
  assert.equal(inAndroidShell(undefined), false);
});

test('the view is snapped to a whole degree, like the server', () => {
  assert.deepEqual(gnssAnchorFromSearch('?lat=30.27&lon=-97.74'), {
    lat: 30,
    lon: -98,
  });
  assert.equal(gnssAnchorFromSearch('?lat=91&lon=0'), null);
  assert.equal(gnssAnchorFromSearch('?lat=abc&lon=0'), null);
  assert.equal(gnssAnchorFromSearch(''), null);
});

test('an adsb.lol snapshot becomes the integrity answer, rows included', async () => {
  let asked = null;
  const response = await gnssIntegrityResponse({
    search: '?lat=30.27&lon=-97.74',
    now: () => NOW,
    upstream: async (url) => {
      asked = url;
      return okUpstream();
    },
  });
  assert.equal(response.status, 200);
  assert.equal(
    asked,
    '/api/upstream?url=' +
      encodeURIComponent('https://api.adsb.lol/v2/lat/30/lon/-98/dist/250'),
  );
  const body = await response.json();
  assert.equal(body.classifier, GNSS_CLASSIFIER.id);
  assert.deepEqual(body.anchor, { lat: 30, lon: -98 });
  assert.equal(body.radiusNm, 250);
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].hex, 'abc123');
});

test('a refused read-through is reported, not thrown', async () => {
  const response = await gnssIntegrityResponse({
    search: '?lat=30&lon=-97',
    upstream: async () => new Response('{}', { status: 403 }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: 'gnss_integrity_unavailable',
  });
});

test('a stale or undated snapshot is refused', async () => {
  const stale = await gnssIntegrityResponse({
    search: '?lat=30&lon=-97',
    now: () => NOW,
    upstream: async () =>
      new Response(JSON.stringify({ ...snapshot, now: (NOW - 3_600_000) / 1000 })),
  });
  assert.equal(stale.status, 502);
  const undated = await gnssIntegrityResponse({
    search: '?lat=30&lon=-97',
    now: () => NOW,
    upstream: async () => new Response(JSON.stringify({ ac: snapshot.ac })),
  });
  assert.equal(undated.status, 502);
});

test('the shim answers its route and leaves every other request alone', async () => {
  const original = globalThis.fetch;
  const calls = [];
  const fetchImpl = async (input) => {
    calls.push(typeof input === 'string' ? input : input.url);
    return new Response('{}', { status: 200 });
  };
  const installed = installInAppApi({
    location: shell,
    fetchImpl,
    upstream: okUpstream,
  });
  assert.equal(installed, true);
  try {
    const handled = await globalThis.fetch('/api/gnss-integrity?lat=30&lon=-97');
    assert.equal(handled.status, 200);
    assert.deepEqual(calls, []);

    const passthrough = await globalThis.fetch('/api/flights');
    assert.equal(passthrough.status, 200);
    assert.deepEqual(calls, ['/api/flights']);

    const post = await globalThis.fetch('/api/gnss-integrity?lat=30&lon=-97', {
      method: 'POST',
    });
    assert.equal(post.status, 405);
  } finally {
    globalThis.fetch = original;
  }
});

test('installing outside the shell changes nothing', async () => {
  let called = false;
  const installed = installInAppApi({
    location: { href: 'http://localhost/', origin: 'http://localhost', hostname: 'localhost' },
    fetchImpl: async () => {
      called = true;
      return new Response('{}', { status: 200 });
    },
  });
  assert.equal(installed, false);
  assert.equal(called, false);
});
