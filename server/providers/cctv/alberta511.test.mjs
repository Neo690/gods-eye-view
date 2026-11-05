import assert from 'node:assert/strict';
import test from 'node:test';

import { loadAlbertaSourcesFromOpenData } from './sources.js';

const ROW = {
  Id: '42',
  Latitude: 51.0447,
  Longitude: -114.0719,
  Location: 'Hwy 2 near Deerfoot Trail',
  Views: [
    {
      Status: 'Enabled',
      Url: 'https://511.alberta.ca/map/Cctv/4201',
      Description: 'Northbound',
    },
  ],
};

function captureConsole(t) {
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  t.mock.method(console, 'warn', capture);
  t.mock.method(console, 'log', capture);
  return lines;
}

test('the keyless TravelIQ catalog is requested and parsed into sources', async (t) => {
  const lines = captureConsole(t);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requested.push(String(url));
    assert.equal(options.headers.Accept, 'application/json');
    return Response.json([ROW]);
  });
  const cameras = await loadAlbertaSourcesFromOpenData(
    { sourceRoot: '/ignored' },
    {},
  );
  assert.equal(requested.length, 1);
  assert.match(
    requested[0],
    /^https:\/\/511\.alberta\.ca\/api\/v2\/get\/cameras/,
  );
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].id, 'ab-42');
  assert.equal(cameras[0].provider, '511 Alberta');
  assert.equal(cameras[0].cityId, 'alberta');
  // The frame URL is pinned to the production origin, not taken verbatim.
  assert.equal(cameras[0].url, 'https://511.alberta.ca/map/Cctv/4201');
  assert.equal(cameras[0].sourceKind, 'alberta-511-open-data');
  // The feed publishes no compass column, but the TravelIQ view description
  // ("Northbound") does carry a direction, so a directional view lands at
  // high confidence facing north.
  assert.equal(cameras[0].headingDeg, 0);
  assert.equal(cameras[0].headingConfidence, 'high');
  assert.equal(lines.some((l) => /Loaded Alberta 511/.test(l)), true);
});

test('a non-directional view falls back to an id-hash heading at low confidence', async (t) => {
  captureConsole(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      Response.json([
        {
          ...ROW,
          Id: '44',
          Views: [
            {
              Status: 'Enabled',
              Url: 'https://511.alberta.ca/map/Cctv/4411',
              Description: '',
            },
          ],
        },
      ]),
  );
  const cameras = await loadAlbertaSourcesFromOpenData({}, {});
  assert.equal(cameras.length, 1);
  assert.ok(Number.isFinite(cameras[0].headingDeg));
  assert.equal(cameras[0].headingConfidence, 'low');
});

test('a staging-host view URL is rewritten onto the production origin', async (t) => {
  captureConsole(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      Response.json([
        {
          ...ROW,
          Id: '43',
          Latitude: 53.5461,
          Longitude: -113.4938,
          Views: [
            {
              Status: 'Enabled',
              // The staging host occasionally carries the same path.
              Url: 'https://ab.stage.traveliq.co/map/Cctv/4407',
              Description: 'Southbound',
            },
          ],
        },
      ]),
  );
  const cameras = await loadAlbertaSourcesFromOpenData({}, {});
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].id, 'ab-43');
  assert.equal(cameras[0].url, 'https://511.alberta.ca/map/Cctv/4407');
});

test('http, off-directory and foreign-frame views drop the row', async (t) => {
  captureConsole(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      Response.json([
        { ...ROW, Id: '1', Views: [{ Status: 'Enabled', Url: 'http://511.alberta.ca/map/Cctv/1' }] },
        // A path the /map/Cctv/ directory does not own is not registered.
        { ...ROW, Id: '2', Views: [{ Status: 'Enabled', Url: 'https://511.alberta.ca/other/2' }] },
        { ...ROW, Id: '3', Views: [{ Status: 'Enabled', Url: 'https://evil.example/map/Cctv/3' }] },
        ROW,
      ]),
  );
  const cameras = await loadAlbertaSourcesFromOpenData({}, {});
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['ab-42'],
  );
});

test('coordinates outside Alberta and disabled views drop the row', async (t) => {
  captureConsole(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      Response.json([
        { ...ROW, Id: '10', Latitude: 44.1 }, // Southeast of the 49th parallel.
        { ...ROW, Id: '11', Longitude: -109.9 }, // Saskatchewan side.
        { ...ROW, Id: '12', Views: [{ Status: 'disabled', Url: ROW.Views[0].Url }] },
        ROW,
      ]),
  );
  const cameras = await loadAlbertaSourcesFromOpenData({}, {});
  assert.deepEqual(
    cameras.map((camera) => camera.id),
    ['ab-42'],
  );
});

test('the source cap is read from the same environment as the kill switch', async (t) => {
  captureConsole(t);
  const rows = Array.from({ length: 12 }, (_, i) => ({
    ...ROW,
    Id: String(100 + i),
    Latitude: ROW.Latitude + i * 0.01,
    Views: [{ ...ROW.Views[0], Url: `https://511.alberta.ca/map/Cctv/${100 + i}` }],
  }));
  t.mock.method(globalThis, 'fetch', async () => Response.json(rows));
  const cameras = await loadAlbertaSourcesFromOpenData(
    {},
    { CCTV_ALBERTA_MAX_SOURCES: '8' },
  );
  assert.equal(cameras.length, 8);
});

test('a failed download is logged and yields an empty pack', async (t) => {
  const lines = captureConsole(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () => Response.json({}, { status: 503 }),
  );
  assert.deepEqual(await loadAlbertaSourcesFromOpenData({}, {}), []);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '[CCTV] Alberta 511 camera download failed: 503');
});

test('a non-array body yields an empty pack without throwing', async (t) => {
  captureConsole(t);
  t.mock.method(
    globalThis,
    'fetch',
    async () => Response.json({ Message: 'no' }),
  );
  assert.deepEqual(await loadAlbertaSourcesFromOpenData({}, {}), []);
});
