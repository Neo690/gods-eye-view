import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadMadridSourcesFromOpenData,
  madridCameraToSource,
} from '../../server/providers/cctv/sources.js';
import {
  MADRID_CAMERAS_URL,
  MADRID_MAX_CATALOG_BYTES,
} from '../../server/providers/cctv/constants.js';
import {
  fallbackHeadingFromId,
  isLikelyMadridCoordinate,
} from '../../server/providers/cctv/normalize.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

/**
 * One Placemark shaped like the live Informo KML: the frame is an escaped HTML
 * snippet carrying a cache-buster, and the position is `lon,lat,alt` (KML
 * order, not lat/lon).
 */
const placemark = ({
  numero = '06303',
  nombre = 'PLAZA DE CASTILLA (NORTE)',
  lat = 40.466063829633,
  lon = -3.68894207537291,
  image = `https://informo.madrid.es/cameras/Camara${numero}.jpg?v=63085`,
  extended = true,
}) => `
    <Placemark>
      <description>&lt;div align=center&gt;&lt;img src=${image}  width=300 height=220/&gt;&lt;br/&gt;${nombre}&lt;/div&gt;</description>
      <styleUrl>#m_ylw-pushpin</styleUrl>
      ${
        extended
          ? `<ExtendedData>
        <Data name="Numero">
          <Value>${numero}</Value>
        </Data>
        <Data name="Nombre">
          <Value>${nombre}</Value>
        </Data>
      </ExtendedData>`
          : ''
      }
      <Point>
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>${lon},${lat},10 </coordinates>
      </Point>
    </Placemark>`;

const catalogFile = (...marks) =>
  `\uFEFF<kml xmlns="http://earth.google.com/kml/2.2">
  <Document>
    <name>CCTV.kml</name>${marks.join('')}
  </Document>
</kml>`;

/** Silences and captures the loader's progress/failure logging. */
function captureConsole(t) {
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  t.mock.method(console, 'warn', capture);
  t.mock.method(console, 'log', capture);
  return lines;
}

test('a Madrid placemark becomes a source on the city image host', () => {
  const camera = madridCameraToSource(
    placemark({ nombre: 'PLAZA DE CASTILLA (NORTE)' }),
  );
  assert.equal(camera.id, 'es-madrid-06303');
  assert.equal(camera.name, 'PLAZA DE CASTILLA (NORTE)');
  assert.equal(camera.city, 'Madrid');
  assert.equal(camera.cityId, 'madrid');
  assert.equal(camera.provider, 'Ayuntamiento de Madrid');
  // KML writes lon,lat; the record carries lat,lon.
  assert.equal(camera.lat, 40.466063829633);
  assert.equal(camera.lon, -3.68894207537291);
  assert.equal(camera.feedType, 'image');
  // The cache-buster is dropped: the registered frame URL is stable.
  assert.equal(camera.url, 'https://informo.madrid.es/cameras/Camara06303.jpg');
  assert.equal(camera.snapshotUrl, camera.url);
  assert.equal(camera.sourceKind, 'madrid-open-data');
  assert.match(camera.license, /CC BY 4\.0/);
  assert.equal(camera.credit, 'Ayuntamiento de Madrid');
  // The KML publishes no bearing, so the shared id-hash prior applies.
  assert.equal(camera.headingDeg, fallbackHeadingFromId(camera.id));
  assert.equal(camera.headingConfidence, 'low');
});

test('a frame on any other host or path is not registered', () => {
  // A lookalike host is not the city's.
  assert.equal(
    madridCameraToSource(
      placemark({
        image: 'https://informo.madrid.es.evil.example/cameras/X.jpg',
      }),
    ),
    null,
  );
  // The right host, a path that is not a camera JPEG.
  assert.equal(
    madridCameraToSource(
      placemark({
        image: 'https://informo.madrid.es/informo/tmadrid/ICO_CAM.gif',
      }),
    ),
    null,
  );
  // A camera-shaped path on another origin.
  assert.equal(
    madridCameraToSource(
      placemark({ image: 'https://example.org/cameras/Camara06303.jpg' }),
    ),
    null,
  );
  // No image at all.
  assert.equal(madridCameraToSource(placemark({ image: '' })), null);
});

test('a placemark outside Madrid is refused, including a swapped position', () => {
  // Paris, in the same order.
  assert.equal(
    madridCameraToSource(placemark({ lat: 48.8566, lon: 2.3522 })),
    null,
  );
  // Lat and lon the wrong way round: not a Madrid coordinate either.
  assert.equal(
    madridCameraToSource(placemark({ lat: -3.6889, lon: 40.466 })),
    null,
  );
  assert.equal(isLikelyMadridCoordinate(40.466, -3.6889), true);
  assert.equal(isLikelyMadridCoordinate(40.466, -3.2), false);
});

test('a placemark without a usable number is skipped', () => {
  assert.equal(madridCameraToSource(placemark({ extended: false })), null);
  assert.equal(madridCameraToSource(placemark({ numero: 'ABC' })), null);
  assert.equal(madridCameraToSource(''), null);
  assert.equal(madridCameraToSource(null), null);
});

test('the loader parses the KML, deduplicates by number and logs the count', async (t) => {
  const lines = captureConsole(t);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requested.push(String(url));
    assert.equal(options.redirect, 'manual');
    return new Response(
      catalogFile(
        placemark({ numero: '06303' }),
        placemark({ numero: '06303' }), // same camera listed twice
        placemark({
          numero: '06304',
          nombre: 'PLAZA DE CASTILLA (SUR)',
          lat: 40.4657761535436,
          lon: -3.68963237924212,
        }),
      ),
      { headers: { 'content-type': 'application/vnd.google-earth.kml+xml' } },
    );
  });
  const cameras = await loadMadridSourcesFromOpenData({}, {});
  assert.deepEqual(requested, [MADRID_CAMERAS_URL]);
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['es-madrid-06303', 'es-madrid-06304'],
  );
  assert.equal(
    lines.some((line) => /Loaded Madrid/.test(line)),
    true,
  );
});

test('the cap keeps the cameras nearest the city anchors', async (t) => {
  captureConsole(t);
  // Farthest listed first: order in the file is not priority, distance is.
  const far = Array.from({ length: 7 }, (_, index) =>
    placemark({
      numero: `0900${index}`,
      nombre: `M-40 ${index}`,
      lat: 40.3,
      lon: -3.7 - index * 0.02,
    }),
  );
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        catalogFile(
          ...far,
          placemark({
            numero: '09010',
            nombre: 'CASTILLA',
            lat: 40.4662,
            lon: -3.6894,
          }),
          placemark({
            numero: '09011',
            nombre: 'SOL',
            lat: 40.4169,
            lon: -3.7037,
          }),
        ),
      ),
  );
  // 8 is the pack floor, so 9 cameras lose the one farthest from an anchor.
  const cameras = await loadMadridSourcesFromOpenData(
    {},
    { CCTV_MADRID_MAX_SOURCES: '8' },
  );
  assert.equal(cameras.length, 8);
  // Each core camera lands on its own anchor; Castilla sits fractionally
  // closer to its anchor than Sol does to the other.
  assert.deepEqual(
    cameras.slice(0, 2).map((camera) => camera.name),
    ['CASTILLA', 'SOL'],
  );
  // Two core slots and six of the seven ring cameras fill the cap; the
  // farthest one is the one dropped.
  assert.deepEqual(
    cameras.map((camera) => camera.name).filter((name) => /^M-40/.test(name)),
    ['M-40 0', 'M-40 1', 'M-40 2', 'M-40 3', 'M-40 4', 'M-40 5'],
  );
  // The pack reports what it offered, so the catalog can show the trim.
  assert.equal(cameras.available, 9);
});

test('a redirect is refused rather than followed', async (t) => {
  const lines = captureConsole(t);
  let followed = false;
  t.mock.method(globalThis, 'fetch', async () => {
    followed = true;
    return new Response(null, {
      status: 302,
      headers: {
        location:
          'https://datos.madrid.es/dataset/202088-0-trafico-camaras/resource/202088-0-trafico-camaras',
      },
    });
  });
  assert.deepEqual(await loadMadridSourcesFromOpenData({}, {}), []);
  assert.equal(followed, true);
  assert.equal(
    lines.some((line) => /Madrid catalog redirected/.test(line)),
    true,
  );
});

test('an upstream error or an oversized body yields no cameras', async (t) => {
  const lines = captureConsole(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('nope', { status: 503 }),
  );
  assert.deepEqual(await loadMadridSourcesFromOpenData({}, {}), []);
  assert.equal(
    lines.some((line) => /Madrid camera download failed: 503/.test(line)),
    true,
  );

  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(catalogFile(placemark({})), {
        headers: { 'content-length': String(MADRID_MAX_CATALOG_BYTES + 1) },
      }),
  );
  assert.deepEqual(await loadMadridSourcesFromOpenData({}, {}), []);
});

/**
 * Serve the Madrid KML to the Madrid endpoint and an empty payload to every
 * other pack, so one catalog refresh exercises the registration without
 * reaching the network. Returns the URLs that were requested.
 */
const runCatalogWithMockedUpstreams = async (t) => {
  const requested = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    const href = String(url);
    requested.push(href);
    if (href.startsWith(MADRID_CAMERAS_URL))
      return new Response(
        catalogFile(
          placemark({ numero: '06303' }),
          placemark({
            numero: '06304',
            nombre: 'PLAZA DE CASTILLA (SUR)',
            lat: 40.4657761535436,
            lon: -3.68963237924212,
          }),
        ),
      );
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

test('with CCTV_MADRID_ENABLED=1 the Madrid lane is wired into the catalog', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    process.env.CCTV_MADRID_ENABLED = '1';
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.ok(
      requested.some((href) => href.startsWith(MADRID_CAMERAS_URL)),
      'the catalog refresh invokes the Madrid loader',
    );
    assert.deepEqual(
      sources
        .filter((source) => source.cityId === 'madrid')
        .map((source) => source.id)
        .sort(),
      ['es-madrid-06303', 'es-madrid-06304'],
      'Madrid cameras reach the served catalog through the registered lane',
    );
  } finally {
    restoreEnv(saved);
  }
});

test('the Madrid lane stays off unless CCTV_MADRID_ENABLED=1', async (t) => {
  const saved = { ...process.env };
  try {
    delete process.env.CCTV_SOURCES_FILE;
    delete process.env.CCTV_SOURCES_JSON;
    delete process.env.CCTV_MADRID_ENABLED;
    const { requested, sources } = await runCatalogWithMockedUpstreams(t);
    assert.equal(
      requested.some((href) => href.startsWith(MADRID_CAMERAS_URL)),
      false,
      'the disabled lane never reaches Informo',
    );
    assert.deepEqual(
      sources.filter((source) => source.cityId === 'madrid'),
      [],
    );
  } finally {
    restoreEnv(saved);
  }
});
