import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';

import {
  cyclonesResponse,
  firePerimetersResponse,
  firmsResponse,
  firmsStatusResponse,
  gbfsResponse,
  militaryInstallationsResponse,
  radiationResponse,
  radioStationsResponse,
  terrainHeightsResponse,
  transitFeedsResponse,
  transitVehiclesResponse,
  weatherImageResponse,
  weatherManifestResponse,
  weatherTileResponse,
  windGridResponse,
  windManifestResponse,
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
  // The shim runs on the real clock, so this snapshot has to be current.
  const freshUpstream = async () =>
    new Response(JSON.stringify({ ...snapshot, now: Date.now() / 1000 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const installed = installInAppApi({
    location: shell,
    fetchImpl,
    upstream: freshUpstream,
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

const perimeter = (id, name) => ({
  type: 'Feature',
  id,
  properties: {
    poly_IncidentName: name,
    attr_UniqueFireIdentifier: id,
    attr_IncidentSize: 1200,
    attr_PercentContained: 40,
  },
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-97.8, 30.2],
        [-97.7, 30.2],
        [-97.7, 30.3],
        [-97.8, 30.2],
      ],
    ],
  },
});
const geoJson = (features, more = false) =>
  new Response(
    JSON.stringify({ type: 'FeatureCollection', features, ...(more ? { exceededTransferLimit: true } : {}) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

test('fire perimeters come back in the server\'s shape', async () => {
  const asked = [];
  const response = await firePerimetersResponse({
    now: () => NOW,
    upstream: async (url) => {
      asked.push(url);
      return geoJson([perimeter('A1', 'Bastrop')]);
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.fetchedAt, NOW);
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].stableId, 'A1');
  assert.equal(body.rows[0].name, 'Bastrop');
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^\/api\/upstream\?url=/);
  assert.match(decodeURIComponent(asked[0]), /services3\.arcgis\.com\/T4QMspbfLg3qTGWY/);
  assert.match(decodeURIComponent(asked[0]), /f=geojson/);
});

test('an exceeded transfer limit pages with resultOffset', async () => {
  const asked = [];
  const response = await firePerimetersResponse({
    upstream: async (url) => {
      asked.push(new URL(url, 'https://appassets.androidplatform.net/').searchParams.get('url'));
      return asked.length === 1
        ? geoJson([perimeter('A1', 'One')], true)
        : geoJson([perimeter('A2', 'Two')]);
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.rows.length, 2);
  assert.equal(asked.length, 2);
  assert.match(asked[1], /resultOffset=1/);
});

test('a refused WFIGS read is reported, not thrown', async () => {
  const response = await firePerimetersResponse({
    upstream: async () => new Response('{}', { status: 502 }),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: 'fire_perimeters_unavailable',
  });
});

test('cyclones answer with the layer\'s document, and admit a dead status read', async () => {
  const now = Date.now();
  const iso = (ms) => new Date(now - ms).toISOString();
  const status = {
    activeStorms: [
      {
        id: 'al092026',
        name: 'Tropical Storm Test',
        classification: 'TS',
        longitudeNumeric: -55.2,
        latitudeNumeric: 22.4,
        lastUpdate: iso(3_600_000),
        intensity: 45,
        pressure: 1002,
        movementDir: 300,
        movementSpeed: 12,
        forecastAdvisory: {
          advNum: '09',
          issuance: iso(7_200_000),
          url: 'https://www.nhc.noaa.gov/text/AL092026.shtml',
        },
      },
    ],
  };
  const empty = { type: 'FeatureCollection', features: [] };
  const ok = await cyclonesResponse({
    now: () => now,
    upstream: async (route) => {
      const target = new URL(route, 'https://appassets.androidplatform.net/').searchParams.get('url');
      const body = target.includes('CurrentStorms') ? status : empty;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(ok.status, 200);
  const doc = await ok.json();
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.unavailable, false);
  assert.equal(doc.storms.length, 1);
  // Empty but valid collections leave the storm pending, as on the server.
  assert.equal(doc.storms[0].geometryStatus, 'pending');

  const down = await cyclonesResponse({
    upstream: async () => new Response('{}', { status: 500 }),
  });
  assert.equal(down.status, 502);
  assert.deepEqual(await down.json(), { error: 'cyclones_unavailable' });
});

test('the radio directory answers in the tuner\'s shape', async () => {
  const row = (uuid, name, lat, lon) => ({
    stationuuid: uuid,
    name,
    url_resolved: 'https://stream.example.com/live.mp3',
    homepage: 'https://example.com',
    geo_lat: lat,
    geo_long: lon,
    tags: 'jazz,news',
    language: 'english',
    state: 'Texas',
    country: 'United States',
    countrycode: 'US',
    codec: 'MP3',
    bitrate: 128,
    clickcount: 12,
    lastcheckok: 1,
    hls: 0,
  });
  const response = await radioStationsResponse({
    now: () => NOW,
    upstream: async () =>
      new Response(
        JSON.stringify([
          row('11111111-1111-1111-1111-111111111111', 'KJazz', 30.2, -97.7),
          { stationuuid: '', name: 'broken' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.updatedAt, new Date(NOW).toISOString());
  assert.ok(Number.isSafeInteger(body.acceptedGeneration));
  assert.ok(body.acceptedGeneration >= 1);
  assert.equal(body.degraded, false);
  assert.equal(body.catalogInstance, 'in-app');
  assert.equal(body.stations.length, 1);
  assert.equal(body.stations[0].name, 'KJazz');
  assert.equal(body.stations[0].lat, 30.2);
});

test('a dead directory reports degraded instead of pretending', async () => {
  const response = await radioStationsResponse({
    upstream: async () => new Response('{}', { status: 500 }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.degraded, true);
});

const heightsUpstream = (asked) => async (route) => {
  const target = new URL(theUrlOf(route));
  const points = decodeURIComponent(target.searchParams.get('points')).split(
    ';',
  );
  asked?.push({ host: target.host, path: target.pathname, points });
  return new Response(
    JSON.stringify({
      results: points.map((pair) => {
        const [lon, lat] = pair.split(',').map(Number);
        return {
          lon,
          lat,
          elevation: 150,
          geoid: -26,
          ellipsoid: lat > 31 ? 165 : 30,
        };
      }),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

test('terrain heights answer in order through the read-through', async () => {
  const asked = [];
  const response = await terrainHeightsResponse({
    search: '?points=-97.70800%2C31.20100%3B-97.76100%2C30.31900',
    upstream: heightsUpstream(asked),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.results.length, 2);
  assert.deepEqual(
    body.results.map((row) => row.ellipsoid),
    [165, 30],
  );
  assert.equal(asked[0].host, 'terrain.reearth.land');
  assert.equal(asked[0].path, '/heights.json');
  // The proxy's own contract: lon,lat at five decimals, semicolon separated.
  assert.deepEqual(asked[0].points, [
    '-97.70800,31.20100',
    '-97.76100,30.31900',
  ]);
});

test('a warm point is not asked for twice', async () => {
  const asked = [];
  const search = '?points=-96.10000%2C30.10000';
  await terrainHeightsResponse({ search, upstream: heightsUpstream(asked) });
  await terrainHeightsResponse({ search, upstream: heightsUpstream(asked) });
  assert.equal(asked.length, 1);
});

test('bad points are refused, and a dead upstream is reported', async () => {
  assert.equal((await terrainHeightsResponse({ search: '?points=nope' })).status, 400);
  assert.equal((await terrainHeightsResponse({ search: '?points=' })).status, 400);
  const many = Array.from({ length: 2001 }, (_, i) => `-97.${i},30.1`).join(';');
  const tooMany = await terrainHeightsResponse({
    search: '?points=' + encodeURIComponent(many),
  });
  assert.equal(tooMany.status, 500);
  // A fresh point with no cache and a refusing upstream has no height to give:
  // the layer then keeps its bundled geoid instead of believing a made-up one.
  const down = await terrainHeightsResponse({
    search: '?points=-95.50000%2C29.50000',
    upstream: async () => new Response('{}', { status: 502 }),
  });
  assert.equal(down.status, 502);
  assert.ok((await down.json()).error);
});

/** A minimal full-dataset GTFS-Realtime FeedMessage, as the page receives it. */
function feedMessage() {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(3, 1_700_000_000);
  writer.writeBytesField(1, header.finish());
  return writer.finish();
}

const theUrlOf = (route) =>
  new URL(route, 'https://appassets.androidplatform.net/').searchParams.get(
    'url',
  );

test('the transit catalog is the registry the layer polls from', () => {
  const response = transitFeedsResponse();
  assert.equal(response.status, 200);
  return response.json().then((body) => {
    assert.ok(body.feeds.length > 0);
    for (const feed of body.feeds) {
      assert.match(feed.id, /^[a-z0-9][a-z0-9-]+$/);
      assert.ok(feed.name);
      assert.ok(feed.center);
    }
  });
});

test('a transit feed is fetched as bytes and decoded in the page', async () => {
  const asked = [];
  const response = await transitVehiclesResponse({
    feedId: 'capmetro-austin',
    now: () => NOW,
    upstream: async (route) => {
      asked.push(route);
      return new Response(feedMessage(), { status: 200 });
    },
  });
  assert.equal(response.status, 200);
  // The body is protobuf: the read-through has to hand back bytes, and the
  // nonce keeps the previous poll from being served as this one.
  assert.match(asked[0], /binary=1/);
  assert.match(asked[0], new RegExp(`_=${NOW}`));
  assert.equal(
    theUrlOf(asked[0]),
    'https://data.texas.gov/download/eiei-9rpf/application%2Foctet-stream',
  );
  const body = await response.json();
  assert.equal(body.feedId, 'capmetro-austin');
  assert.equal(body.fetchedAt, NOW);
  assert.equal(body.version, '2.0');
  assert.deepEqual(body.vehicles, []);
  assert.equal(response.headers.get('x-gev-cache'), 'MISS');
  assert.equal(response.headers.get('x-transit-contact'), String(NOW));
});

test('an unknown, refused or unreadable transit feed invents nothing', async () => {
  const unknown = await transitVehiclesResponse({
    feedId: 'not-a-feed',
    upstream: async () => new Response(feedMessage(), { status: 200 }),
  });
  assert.equal(unknown.status, 404);

  const refused = await transitVehiclesResponse({
    feedId: 'mbta',
    upstream: async () => new Response('{}', { status: 502 }),
  });
  assert.equal(refused.status, 504);
  assert.equal((await refused.json()).feedId, 'mbta');

  const garbage = await transitVehiclesResponse({
    feedId: 'mbta',
    upstream: async () => new Response(new Uint8Array([0xff, 0xff, 0xff])),
  });
  assert.equal(garbage.status, 502);
});

test('gbfs answers allowlisted station documents and nothing else', async () => {
  const austin = encodeURIComponent(
    'https://austin.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
  );
  const payload = { data: { stations: [{ station_id: 'a1', num_bikes_available: 7 }] } };
  const asked = [];
  const ok = await gbfsResponse({
    encoded: austin,
    upstream: async (route) => {
      asked.push(theUrlOf(route));
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  assert.equal(ok.status, 200);
  assert.equal(
    asked[0],
    'https://austin.publicbikesystem.net/customer/gbfs/v2/en/station_status.json',
  );
  assert.deepEqual(await ok.json(), payload);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('x-gbfs-upstream'), 'austin.publicbikesystem.net');

  const info = await gbfsResponse({
    encoded: encodeURIComponent(
      'https://austin.publicbikesystem.net/customer/gbfs/v2/en/station_information.json',
    ),
    upstream: async () => new Response(JSON.stringify(payload), { status: 200 }),
  });
  assert.equal(info.headers.get('cache-control'), 'public, max-age=300');

  const foreign = await gbfsResponse({
    encoded: encodeURIComponent('https://example.com/gbfs/station_status.json'),
    upstream: async () => new Response('{}', { status: 200 }),
  });
  assert.equal(foreign.status, 403);

  // An allowlisted host that is not asked for its station document is refused
  // too: the proxy is not a general relay.
  const wrongPath = await gbfsResponse({
    encoded: encodeURIComponent(
      'https://austin.publicbikesystem.net/customer/gbfs/v2/en/system_information.json',
    ),
    upstream: async () => new Response('{}', { status: 200 }),
  });
  assert.equal(wrongPath.status, 403);

  assert.equal((await gbfsResponse({ encoded: '%E0%A4%A' })).status, 400);
  assert.equal((await gbfsResponse({ encoded: '' })).status, 400);

  const down = await gbfsResponse({
    encoded: austin,
    upstream: async () => new Response('not json', { status: 502 }),
  });
  assert.equal(down.status, 502);
});

test('mapped installations answer the capability the shell does not have', async () => {
  const response = militaryInstallationsResponse();
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'OVERPASS_NOT_CONFIGURED');
  assert.equal(body.retryable, false);
});

test('the shim routes the paths that carry their subject', async () => {
  const original = globalThis.fetch;
  const calls = [];
  const upstream = async (route) => {
    calls.push(route);
    return new Response(feedMessage(), { status: 200 });
  };
  installInAppApi({
    location: shell,
    fetchImpl: async (input) => {
      throw new Error('the shim should have answered ' + input);
    },
    upstream,
  });
  try {
    const vehicles = await globalThis.fetch(
      '/api/transit/vehicles/capmetro-austin?t=1',
    );
    assert.equal(vehicles.status, 200);
    assert.equal((await vehicles.json()).feedId, 'capmetro-austin');

    const feeds = await globalThis.fetch('/api/transit/feeds');
    assert.equal(feeds.status, 200);

    const installations = await globalThis.fetch(
      '/api/military-installations?south=30&west=-98&north=30.1&east=-97.9',
    );
    assert.equal(installations.status, 503);

    const gbfs = await globalThis.fetch(
      '/api/gbfs/' +
        encodeURIComponent(
          'https://example.com/gbfs/station_status.json',
        ),
    );
    assert.equal(gbfs.status, 403);

    const terrain = await globalThis.fetch(
      '/api/terrain/heights?points=-97.75000%2C30.27000',
    );
    // The stub upstream answers GTFS bytes, so the terrain read fails — but it
    // fails inside the route, which is what proves the path is wired.
    assert.equal(terrain.status, 502);
    assert.match(decodeURIComponent(calls.at(-1)), /terrain\.reearth\.land/);

    const method = await globalThis.fetch('/api/transit/feeds', {
      method: 'POST',
    });
    assert.equal(method.status, 405);

    const radiation = await globalThis.fetch('/api/radiation');
    // The stub upstream answers GTFS bytes, so radiation networks fail to parse,
    // which results in 503 radiation_unavailable inside the route — proving the path is wired.
    assert.equal(radiation.status, 503);
  } finally {
    globalThis.fetch = original;
  }
});

test('radiationResponse aggregates public radiation networks and handles failures gracefully', async () => {
  const clock = Date.UTC(2026, 9, 25, 8, 0, 0);
  const bfsData = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [10.5, 50.1] },
        properties: {
          kenn: 'bfs-1',
          name: 'Station 1',
          value: 0.12,
          end_measure: '2026-10-25T07:00:00Z',
        },
      },
    ],
  };

  const response = await radiationResponse({
    now: () => clock,
    upstream: async (url) => {
      const decoded = decodeURIComponent(url);
      if (decoded.includes('imis.bfs.de')) {
        return new Response(JSON.stringify(bfsData), { status: 200 });
      }
      return new Response('upstream error', { status: 502 });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Data-Degraded'), 'true');
  const body = await response.json();
  assert.equal(body.fetchedAt, clock);
  assert.equal(body.stations.length, 1);
  assert.equal(body.stations[0].network, 'bfs');
  assert.equal(body.sources.length, 4);
  assert.equal(body.sources.find((s) => s.id === 'bfs').ok, true);
  assert.equal(body.sources.find((s) => s.id === 'canada').ok, false);
});

test('radiationResponse returns 503 when all networks and space data fail', async () => {
  const response = await radiationResponse({
    upstream: async () => new Response('error', { status: 502 }),
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'radiation_unavailable');
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

test('firmsResponse parses open NASA CSV and answers with fire records', async () => {
  const csv = [
    'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight',
    '-14.816,48.861,300.1,1.0,1.0,2026-10-23,1700,A,MODIS,50,6.1NRT,290.0,8.5,D',
  ].join('\n');

  const res = await firmsResponse({
    now: () => NOW,
    upstream: async () => new Response(csv, { status: 200 }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.count, 1);
  assert.equal(data.fires.length, 1);
  assert.equal(data.fires[0].lat, -14.816);
});

test('weatherManifestResponse builds valid NOAA nowCOAST manifest', async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0">
  <Capability>
    <Layer>
      <Name>conus_base_reflectivity_mosaic</Name>
      <Dimension name="time" units="ISO8601">2026-10-23T17:50:00Z,2026-10-23T17:55:00Z</Dimension>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

  const res = await weatherManifestResponse({
    search: '?product=radar',
    now: () => NOW,
    upstream: async () => new Response(xml, { status: 200 }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.product, 'radar');
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.latest, '2026-10-23T17:55:00.000Z');
});

test('windManifestResponse and windGridResponse answer with valid GFS grid', async () => {
  const mRes = windManifestResponse({ search: '?model=gfs', now: () => NOW });
  assert.equal(mRes.status, 200);
  const manifest = await mRes.json();
  assert.equal(manifest.model, 'gfs');
  assert.equal(manifest.grid.nx, 360);
  assert.equal(manifest.grid.ny, 181);

  const gRes = windGridResponse({ now: () => NOW });
  assert.equal(gRes.status, 200);
  const bytes = await gRes.arrayBuffer();
  assert.equal(bytes.byteLength, 360 * 181 * 2 * 4);
});

test('weatherTileResponse answers with PNG for within bounds and transparent PNG for out of bounds', async () => {
  // Out of bounds tile for radar (e.g. z=2, x=0, y=0 covers west=-180 to -135, radar starts at -130)
  const oobRes = await weatherTileResponse({
    search: '?product=radar&time=2026-10-23T17:55:00.000Z&z=2&x=0&y=0',
  });
  assert.equal(oobRes.status, 200);
  assert.equal(oobRes.headers.get('content-type'), 'image/png');
  const oobBytes = await oobRes.arrayBuffer();
  assert.equal(oobBytes.byteLength, 334);

  // In-bounds tile for radar
  const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const inRes = await weatherTileResponse({
    search: '?product=radar&time=2026-10-23T17:55:00.000Z&z=2&x=1&y=1',
    upstream: async () => new Response(fakePng, { status: 200 }),
  });
  assert.equal(inRes.status, 200);
  assert.equal(inRes.headers.get('content-type'), 'image/png');
});
