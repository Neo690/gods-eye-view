import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { build, createServer, preview } from 'vite';
import { localProviderPlugins } from '../../server/providers/local.js';
import { apiNotFoundPlugin } from '../../server/standalone/api-not-found.js';
import { makeFixtureRoot } from './fixtureRoot.mjs';

test('every provider has both hooks; credential editing serves both servers and never a build', () => {
  const plugins = localProviderPlugins();
  assert.ok(plugins.some(({ name }) => name === 'fire-perimeters'));
  assert.ok(plugins.some(({ name }) => name === 'gnss-integrity'));
  for (const plugin of plugins) {
    assert.equal(typeof plugin.configureServer, 'function', plugin.name);
    assert.equal(typeof plugin.configurePreviewServer, 'function', plugin.name);
    if (plugin.name !== 'gev-key-setup') continue;
    // The packaged desktop app runs `vite preview`, so Provider Settings works
    // there too; what keeps every other caller out is the admission gate below,
    // not which hook installed the routes.
    assert.equal(plugin.apply({}, { command: 'serve', isPreview: true }), true);
    assert.equal(
      plugin.apply({}, { command: 'serve', isPreview: false }),
      true,
    );
    assert.equal(plugin.apply({}, { command: 'build' }), false);
  }
});

test('real dev and built-preview servers serve provider JSON and terminate unknown APIs', async (t) => {
  // Physical path: Vite's root and the files written under it must agree on one
  // spelling, and macOS reaches the temp directory through a symlink.
  const root = await makeFixtureRoot('gev-preview-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><title>Preview fixture</title><p>Built application</p>',
  );
  for (const [name, value] of Object.entries({
    AISSTREAM_API_KEY: '',
    FIRMS_MAP_KEY: '',
    FIRMS_API_KEY: '',
    TOMTOM_API_KEY: '',
    GOOGLE_MAPS_API_KEY: '',
    GOOGLE_MAPS_SERVER_API_KEY: '',
    MAPILLARY_CLIENT_TOKEN: '',
    OPENAI_API_KEY: '',
    OPENSKY_AUTH_MODE: 'anon',
    OPENSKY_CLIENT_ID: '',
    OPENSKY_CLIENT_SECRET: '',
    CCTV_FORCE_AUSTIN: '0',
    CCTV_SOURCES_FILE: path.join(root, 'absent.json'),
    CCTV_SOURCES_JSON: JSON.stringify([
      { id: 'fixture', lat: 30.27, lon: -97.74 },
    ]),
  })) {
    const before = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (raw, options) => {
    const url = new URL(raw);
    if (url.hostname === '127.0.0.1') return nativeFetch(raw, options);
    assert.ok(
      ['opensky-network.org', 'api.adsb.lol'].includes(url.hostname),
      url.origin,
    );
    return Response.json({
      time: Math.floor(Date.now() / 1000),
      states: [],
      ac: [],
    });
  });
  const base = {
    root,
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: 'silent',
  };
  await build(base);
  for (const isPreview of [false, true]) {
    const config = {
      ...base,
      plugins: [...localProviderPlugins(), apiNotFoundPlugin()],
      server: { host: '127.0.0.1', port: 0, hmr: false },
      preview: { host: '127.0.0.1', port: 0 },
    };
    const server = isPreview
      ? await preview(config)
      : await createServer(config);
    if (!isPreview) await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    try {
      for (const [route, status] of [
        ['/api/flights', 200],
        ['/api/military', 200],
        ['/api/adsbdb/type/invalid', 400],
        ['/api/firms/status', 200],
        ['/api/fire-perimeters/inciweb/publication/invalid', 400],
        ['/api/gnss-integrity?lat=invalid', 400],
        ['/api/terrain/heights?points=invalid', 400],
        ['/api/overpass', 405],
        ['/api/overpass/status', 200],
        ['/api/cctv/sources', 200],
        ['/api/gbfs/', 400],
        ['/api/tomtom/status', 200],
        // The Street Level QA gate intercepts these in the browser; this is
        // the check that the real servers register them.
        ['/api/mapillary/status', 200],
        ['/api/mapillary/tiles/coverage/14/1/2', 503],
        ['/api/radio/unknown', 404],
        ['/api/setup/status', 200],
        ['/api/setup/update', 404],
        ['/api/does-not-exist', 404],
        ['/api', 404],
      ]) {
        const response = await fetch(origin + route);
        assert.equal(
          response.status,
          status,
          `${isPreview ? 'preview' : 'dev'} ${route}`,
        );
        assert.match(
          response.headers.get('content-type'),
          /application\/json/,
          route,
        );
        const body = await response.json();
        if (route === '/api/cctv/sources')
          assert.equal(body.sources[0].id, 'fixture');
        if (route === '/api/mapillary/status')
          assert.deepEqual(body, { configured: false }, route);
        if (route.startsWith('/api/mapillary/tiles'))
          assert.deepEqual(body, { error: 'no_key', keyRequired: true }, route);
        if (route === '/api/does-not-exist') {
          assert.deepEqual(body, { error: 'Unknown API route' });
          assert.equal(response.headers.get('cache-control'), 'no-store');
        }
        if (route === '/api/setup/status') {
          assert.ok(Array.isArray(body.keys) && body.keys.length, route);
          assert.equal(typeof body.setCount, 'number', route);
        }
      }
      const tle = await fetch(origin + '/api/celestrak/invalid!');
      assert.equal(tle.status, 400);
      assert.equal(await tle.text(), 'invalid group');
      if (isPreview) {
        // The preview server serves Provider Settings now, because the packaged
        // desktop app runs one. Its admission gate is the boundary: a POST with
        // no Origin, and one carrying proxy headers, are both refused, and
        // neither can write the store.
        for (const [code, headers] of [
          ['origin-required', {}],
          ['proxied', { Origin: origin, 'X-Forwarded-For': '203.0.113.7' }],
        ]) {
          const write = await fetch(origin + '/api/setup/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ GOOGLE_MAPS_API_KEY: 'must-not-save' }),
          });
          assert.equal(write.status, 403, `preview setup/keys ${code}`);
          assert.equal((await write.json()).code, code);
        }
        assert.equal(existsSync(path.join(root, '.env')), false);
      }
      for (const route of ['/', '/application-route', '/apiary']) {
        const response = await fetch(origin + route);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.match(await response.text(), /Built application/);
      }
    } finally {
      await server.close();
    }
  }
});
