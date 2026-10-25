import test from 'node:test';
import assert from 'node:assert/strict';

import { relayedTileFetch, relayedTileUrl } from './layerSources.js';

const shell = {
  href: 'https://appassets.androidplatform.net/index.html',
  origin: 'https://appassets.androidplatform.net',
  hostname: 'appassets.androidplatform.net',
};
const desktop = { hostname: 'localhost', origin: 'http://localhost:5173' };
const TILE =
  'https://tiles.openfreemap.org/planet/20261018_080001_pt/14/8387/13455.pbf';

test('tile reads are relayed only inside the shell, and only for the tiles', () => {
  assert.equal(
    relayedTileUrl(TILE, shell),
    `/api/upstream?url=${encodeURIComponent(TILE)}`,
    'the shell asks its own relay for the bytes',
  );
  assert.equal(
    relayedTileUrl('https://tiles.openfreemap.org/planet', shell),
    '/api/upstream?url=https%3A%2F%2Ftiles.openfreemap.org%2Fplanet',
    'and for the TileJSON that names the version in use',
  );
  assert.equal(relayedTileUrl(TILE, desktop), null, 'a desktop read stands');
  for (const raw of [
    // Another host, another shape on this host, and anything unparsable: the
    // relay would refuse each of these, so none of them is asked of it.
    'https://tiles.example.com/planet/v/14/8387/13455.pbf',
    'https://tiles.openfreemap.org/styles/positron',
    'https://tiles.openfreemap.org/planet/v/14/8387/13455.json',
    'not-a-url',
    null,
    undefined,
  ])
    assert.equal(relayedTileUrl(raw, shell), null, String(raw));
});

test('the wrapper relays tiles and passes every other read through', async () => {
  const seen = [];
  const relay = relayedTileFetch({
    location: shell,
    fetchImpl: async (input, init) => {
      seen.push({ input, signal: init?.signal, redirect: init?.redirect });
      return new Response('ok');
    },
  });
  const controller = new AbortController();
  await relay(TILE, { signal: controller.signal, redirect: 'error' });
  await relay('/api/transit/feeds');
  assert.equal(seen[0].input, `/api/upstream?url=${encodeURIComponent(TILE)}`);
  assert.equal(seen[0].signal, controller.signal, 'the caller keeps its abort');
  assert.equal(seen[0].redirect, 'error', 'and its redirect rule');
  assert.equal(seen[1].input, '/api/transit/feeds', 'no other route moves');

  const direct = relayedTileFetch({
    location: desktop,
    fetchImpl: async (input) => {
      seen.push({ input });
      return new Response('ok');
    },
  });
  await direct(TILE);
  assert.equal(seen[2].input, TILE, 'a desktop build keeps fetching tiles itself');
});
