import assert from 'node:assert/strict';
import test from 'node:test';

import { georgiaRowToSource, loadGeorgiaSourcesFromOpenData } from './sources.js';

const ROW = {
  id: '4023',
  location: 'I-75 SB at Windy Hill Rd',
  direction: 'Southbound',
  latLng: {
    geography: { wellKnownText: 'POINT (-84.4702 33.8683)' },
  },
  images: [
    { imageUrl: 'http://navigator-c2c.dot.ga.gov/cams/4023.jpg' },
  ],
};

function captureConsole(t) {
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  t.mock.method(console, 'warn', capture);
  t.mock.method(console, 'log', capture);
  return lines;
}

function pageBody(pageIndex, rows, total) {
  return Response.json({ data: rows, recordsTotal: total });
}

test('a DataTables row parses to a pinned source with a directional heading', () => {
  const source = georgiaRowToSource(ROW);
  assert.equal(source.id, 'ga-4023');
  assert.equal(source.lat, 33.8683);
  assert.equal(source.lon, -84.4702);
  // Plain http and the feed's persistent host misspelling both normalize onto
  // one registered HTTPS origin.
  assert.equal(source.url, 'https://navigator-c2c.dot.ga.gov/cams/4023.jpg');
  assert.equal(source.snapshotUrl, source.url);
  assert.equal(source.provider, '511 Georgia');
  assert.equal(source.cityId, 'georgia');
  assert.equal(source.sourceKind, 'georgia-511-open-data');
  // A published compass direction is honored at high confidence.
  assert.equal(source.headingDeg, 180);
  assert.equal(source.headingConfidence, 'high');
  assert.doesNotMatch(source.license, /undefined/);
});

test('blocked images, off-host frames and off-state rows are refused', () => {
  const blocked = georgiaRowToSource({
    ...ROW,
    images: [{ imageUrl: 'https://511ga.org/1.jpg', blocked: true }],
  });
  assert.equal(blocked, null);

  const foreign = georgiaRowToSource({
    ...ROW,
    images: [{ imageUrl: 'https://evil.example/cams/1.jpg' }],
  });
  assert.equal(foreign, null);

  const locate = georgiaRowToSource({
    ...ROW,
    latLng: { geography: { wellKnownText: 'POINT (0 0)' } },
  });
  assert.equal(locate, null);

  const untyped = georgiaRowToSource({
    ...ROW,
    latLng: { geography: { wellKnownText: 'not a point' } },
  });
  assert.equal(untyped, null);

  // WKT is written x y (lon lat) and must be read that way.
  const flipped = georgiaRowToSource({
    ...ROW,
    latLng: { geography: { wellKnownText: 'POINT (-83.6324 32.8407)' } },
  });
  assert.equal(flipped.lon, -83.6324);
  assert.equal(flipped.lat, 32.8407);
});

test('the misspelled host is corrected in the frame URL', () => {
  const source = georgiaRowToSource({
    ...ROW,
    images: [{ imageUrl: 'http://navigatos-c2c.dot.ga.gov/cams/9.jpg' }],
  });
  assert.equal(source.url, 'https://navigator-c2c.dot.ga.gov/cams/9.jpg');
});

test('the camera table is POSTed with the DataTables protocol, paged to total', async (t) => {
  const lines = captureConsole(t);
  const requested = [];
  let call = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requested.push({ url: String(url), options });
    call += 1;
    if (call === 1) {
      const rows = Array.from({ length: 2 }, (_, i) => ({
        id: `10${i}`,
        location: 'I-285 at Colorow',
        latLng: {
          geography: {
            wellKnownText: `POINT (-84.5${i} 33.9)`,
          },
        },
        images: [{ imageUrl: `https://navigator-c2c.dot.ga.gov/cams/${i}.jpg` }],
      }));
      return pageBody(0, rows, 3);
    }
    return pageBody(1, [{ ...ROW }], 3);
  });
  const cameras = await loadGeorgiaSourcesFromOpenData(
    { sourceRoot: '/ignored' },
    {},
  );
  // Two pages were needed: page 1 filled two rows of three, page 2 the last.
  assert.equal(requested.length, 2);
  const [a, b] = requested;
  assert.match(a.url, /^https:\/\/511ga\.org\/List\/GetData\/Cameras$/);
  assert.equal(a.options.method, 'POST');
  assert.equal(a.options.headers.Origin, 'https://511ga.org');
  assert.equal(a.options.headers.Referer, 'https://511ga.org/cctv');
  assert.deepEqual(JSON.parse(a.options.body), { draw: 1, start: 0, length: 500 });
  assert.deepEqual(JSON.parse(b.options.body), { draw: 2, start: 2, length: 500 });
  assert.equal(cameras.length, 3);
  assert.equal(lines.some((l) => /Loaded Georgia camera sources: 3/.test(l)), true);
});

test('a partially reported table stops when a page returns zero rows', async (t) => {
  captureConsole(t);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (_url, _options) => {
    requested.push(1);
    return pageBody(0, [ROW], 0);
  });
  const cameras = await loadGeorgiaSourcesFromOpenData({}, {});
  assert.equal(requested.length, 1);
  assert.equal(cameras.length, 1);
});

test('a failed page keeps the rows the earlier pages returned', async (t) => {
  const lines = captureConsole(t);
  let call = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    call += 1;
    if (call === 1) return pageBody(0, [ROW], 600);
    // 600 rows reported, page 1 returned one (a short-but-live table), so the
    // pager reads on; the second page then fails. The partial read stands.
    return Response.json({ message: 'nope' }, { status: 503 });
  });
  const cameras = await loadGeorgiaSourcesFromOpenData({}, {});
  assert.equal(cameras.length, 1);
  assert.match(lines.join('\n'), /Georgia camera download failed: 503/);
});

test('the source cap is read from the same environment as the kill switch', async (t) => {
  captureConsole(t);
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: `50${i}`,
    location: 'I-85 N',
    latLng: { geography: { wellKnownText: `POINT (-84.4${i} 33.8${i})` } },
    images: [{ imageUrl: `https://navigator-c2c.dot.ga.gov/cams/${i}.jpg` }],
  }));
  t.mock.method(globalThis, 'fetch', async () => pageBody(0, rows, 12));
  const cameras = await loadGeorgiaSourcesFromOpenData(
    {},
    { CCTV_GEORGIA_MAX_SOURCES: '8' },
  );
  assert.equal(cameras.length, 8);
});

test('embedded credentials and explicit ports in a frame URL are refused', () => {
  const withUser = georgiaRowToSource({
    ...ROW,
    images: [{ imageUrl: 'https://user:pass@navigator-c2c.dot.ga.gov/cams/1.jpg' }],
  });
  assert.equal(withUser, null);

  const withPort = georgiaRowToSource({
    ...ROW,
    images: [{ imageUrl: 'https://navigator-c2c.dot.ga.gov:8443/cams/1.jpg' }],
  });
  assert.equal(withPort, null);
});
