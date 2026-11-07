import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  illinoisFeatureToSource,
  loadIllinoisSourcesFromOpenData,
} from '../../server/providers/cctv/sources.js';
import {
  ILLINOIS_CAMERAS_URL,
  ILLINOIS_PAGE_SIZE,
} from '../../server/providers/cctv/constants.js';
import {
  fallbackHeadingFromId,
  isLikelyIllinoisCoordinate,
} from '../../server/providers/cctv/normalize.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

const IMAGE_BASE = 'https://cctv.travelmidwest.com/snapshots/';

/** One feature shaped like the live layer (`TrafficCamerasTM_Public`). */
const feature = (overrides = {}) => ({
  attributes: {
    OBJECTID: 1,
    CameraLocation: 'I-90 at Elm St',
    CameraDirection: 'W',
    SnapShot: `${IMAGE_BASE}IL-IDOTD1_1_Cook_WB_Albin_4188597_-8791483_2_W.jpg`,
    TooOld: 'false',
    y: 41.88597,
    x: -87.91483,
    ...overrides,
  },
});

/** An ArcGIS page body. */
const page = (features, more = false) =>
  Response.json({ features, exceededTransferLimit: more });

function captureConsole(t) {
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  t.mock.method(console, 'warn', capture);
  t.mock.method(console, 'log', capture);
  return lines;
}

test('an Illinois feature becomes a camera with the view direction as its bearing', () => {
  const camera = illinoisFeatureToSource(feature());
  assert.equal(camera.id, 'us-il-1');
  assert.equal(camera.name, 'I-90 at Elm St (W)');
  assert.equal(camera.city, 'Illinois');
  assert.equal(camera.cityId, 'illinois');
  assert.equal(camera.provider, 'Illinois DOT (Gateway)');
  assert.equal(camera.lat, 41.88597);
  assert.equal(camera.lon, -87.91483);
  assert.equal(camera.headingDeg, 270);
  assert.equal(camera.headingConfidence, 'high');
  assert.equal(camera.feedType, 'image');
  assert.equal(
    camera.url,
    `${IMAGE_BASE}IL-IDOTD1_1_Cook_WB_Albin_4188597_-8791483_2_W.jpg`,
  );
  assert.equal(camera.snapshotUrl, camera.url);
  assert.equal(camera.sourceKind, 'illinois-gateway-open-data');
  assert.match(camera.license, /CC BY-SA 2\.0/);
  assert.equal(camera.credit, 'Illinois Department of Transportation');
});

test('a view with no direction letter falls back to the id hash at low confidence', () => {
  const camera = illinoisFeatureToSource(feature({ CameraDirection: 'NONE' }));
  assert.equal(camera.name, 'I-90 at Elm St');
  assert.equal(camera.headingDeg, fallbackHeadingFromId(camera.id));
  assert.equal(camera.headingConfidence, 'low');
});

test('a stale frame or a foreign image host is not registered', () => {
  assert.equal(illinoisFeatureToSource(feature({ TooOld: 'true' })), null);
  // Lake County PASSAGE frames live on a partner agency's host, outside the
  // IDOT layer's licence declaration, so they are not proxied.
  assert.equal(
    illinoisFeatureToSource(
      feature({ SnapShot: 'https://www.lakecountypassage.com/cam/frame.jpg' }),
    ),
    null,
  );
  // Right host, a path that is not a snapshot.
  assert.equal(
    illinoisFeatureToSource(feature({ SnapShot: `${IMAGE_BASE}../other.jpg` })),
    null,
  );
  assert.equal(illinoisFeatureToSource(feature({ SnapShot: '' })), null);
});

test('a camera outside Illinois or without a usable id is skipped', () => {
  // Chicago's longitude with a Texas latitude, then a swapped pair.
  assert.equal(illinoisFeatureToSource(feature({ y: 30.27 })), null);
  assert.equal(illinoisFeatureToSource(feature({ y: -87.9, x: 41.8 })), null);
  assert.equal(isLikelyIllinoisCoordinate(41.88597, -87.91483), true);
  assert.equal(isLikelyIllinoisCoordinate(41.88597, -80), false);
  assert.equal(illinoisFeatureToSource(feature({ OBJECTID: null })), null);
  assert.equal(illinoisFeatureToSource(feature({ OBJECTID: 0 })), null);
  assert.equal(illinoisFeatureToSource({}), null);
  assert.equal(illinoisFeatureToSource(null), null);
});

test('the loader walks the paged layer until it reports no more', async (t) => {
  captureConsole(t);
  const offsets = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const parsed = new URL(String(url));
    offsets.push(parsed.searchParams.get('resultOffset'));
    assert.equal(parsed.searchParams.get('outSR'), '4326');
    assert.equal(parsed.searchParams.get('f'), 'json');
    assert.equal(options.redirect, 'manual');
    if (parsed.searchParams.get('resultOffset') === '0') {
      // A full page with more behind it.
      return page(
        Array.from({ length: ILLINOIS_PAGE_SIZE }, (_, i) =>
          feature({
            OBJECTID: i + 1,
            SnapShot: `${IMAGE_BASE}cam${i + 1}.jpg`,
          }),
        ),
        true,
      );
    }
    return page([
      feature({ OBJECTID: 5001, SnapShot: `${IMAGE_BASE}cam5001.jpg` }),
      feature({
        OBJECTID: 5002,
        SnapShot: `${IMAGE_BASE}cam5002.jpg`,
        CameraLocation: 'I-55 at Weber',
      }),
    ]);
  });
  const cameras = await loadIllinoisSourcesFromOpenData(
    {},
    { CCTV_ILLINOIS_MAX_SOURCES: '1200' },
  );
  assert.deepEqual(offsets, ['0', '1000']);
  assert.equal(cameras.length, ILLINOIS_PAGE_SIZE + 2);
  assert.equal(cameras.available, ILLINOIS_PAGE_SIZE + 2);
  // The short second page ends the walk: no third request.
  assert.equal(offsets.length, 2);
});

test('the cap keeps the cameras nearest the state anchors', async (t) => {
  captureConsole(t);
  // Ten cameras far from every anchor, so the cap of 8 has to trim two.
  const far = Array.from({ length: 10 }, (_, index) =>
    feature({
      OBJECTID: 100 + index,
      CameraLocation: `IL 1 south ${index}`,
      SnapShot: `${IMAGE_BASE}far${index}.jpg`,
      y: 37.9,
      x: -89.2,
    }),
  );
  t.mock.method(globalThis, 'fetch', async () =>
    page([
      ...far,
      feature({
        OBJECTID: 201,
        CameraLocation: 'Chicago Loop',
        SnapShot: `${IMAGE_BASE}chi.jpg`,
        y: 41.8781,
        x: -87.6298,
      }),
      feature({
        OBJECTID: 202,
        CameraLocation: 'Springfield',
        SnapShot: `${IMAGE_BASE}spi.jpg`,
        y: 39.798,
        x: -89.644,
      }),
    ]),
  );
  const cameras = await loadIllinoisSourcesFromOpenData(
    {},
    { CCTV_ILLINOIS_MAX_SOURCES: '8' },
  );
  // Eight of the twelve are kept, both anchor cameras among them; the ten far
  // cameras lose two to the cap.
  assert.equal(cameras.length, 8);
  assert.equal(cameras[0].name, 'Chicago Loop (W)');
  assert.ok(
    cameras.some((camera) => camera.name === 'Springfield (W)'),
    'every anchor camera survives the trim',
  );
  assert.equal(cameras.available, 12);
});

test('a redirect or a failing layer yields no cameras', async (t) => {
  const lines = captureConsole(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://elsewhere.example/' },
      }),
  );
  assert.deepEqual(await loadIllinoisSourcesFromOpenData({}, {}), []);
  assert.equal(
    lines.some((line) => /Illinois catalog redirected/.test(line)),
    true,
  );

  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('nope', { status: 503 }),
  );
  assert.deepEqual(await loadIllinoisSourcesFromOpenData({}, {}), []);
  assert.equal(
    lines.some((line) => /Illinois camera download failed: 503/.test(line)),
    true,
  );
});

/**
 * Serve the layer to the Illinois endpoint and an empty payload to every other
 * pack, so one catalog refresh exercises the registration without reaching the
 * network. Returns the URLs that were requested.
 */
const runCatalogWithMockedUpstreams = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href.startsWith(ILLINOIS_CAMERAS_URL))
      return page([
        feature({ OBJECTID: 606, CameraLocation: 'IL 29 at Fayette Ave.' }),
        feature({
          OBJECTID: 607,
          CameraLocation: 'IL 29 at Fayette Ave.',
          CameraDirection: 'S',
          SnapShot: `${IMAGE_BASE}cam607.jpg`,
        }),
      ]);
    return Response.json([]);
  });
  // No curated catalogs or ground-height sidecar, so only live lanes are in play.
  const sources = await createCctvCatalog({ sourceRoot: '/nonexistent' })();
  return { requested, sources };
};

/** Put process.env back exactly as it was. */
const restoreEnv = (saved) => {
  for (const key of Object.keys(process.env)) {
    if (key in saved) continue;
    delete process.env[key];
  }
  Object.assign(process.env, saved);
};

test('with CCTV_ILLINOIS_ENABLED=1 the Illinois lane is wired into the catalog', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    process.env.CCTV_ILLINOIS_ENABLED = '1';
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.ok(
      requested.some((href) => href.startsWith(ILLINOIS_CAMERAS_URL)),
      'the catalog refresh invokes the Illinois loader',
    );
    assert.deepEqual(
      sources
        .filter((source) => source.cityId === 'illinois')
        .map((source) => source.id)
        .sort(),
      ['us-il-606', 'us-il-607'],
      'Illinois cameras reach the served catalog through the registered lane',
    );
  } finally {
    restoreEnv(saved);
  }
});

test('the Illinois lane stays off unless CCTV_ILLINOIS_ENABLED=1', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_ILLINOIS_ENABLED;
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.equal(
      requested.some((href) => href.startsWith(ILLINOIS_CAMERAS_URL)),
      false,
      'the disabled lane never reaches the ArcGIS layer',
    );
    assert.deepEqual(
      sources.filter((source) => source.cityId === 'illinois'),
      [],
    );
  } finally {
    restoreEnv(saved);
  }
});
