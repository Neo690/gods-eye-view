import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cellSourceFromUrl,
  cellTowersProxy,
  cellViewFromUrl,
  filterSites,
  mapOpenCellIdCell,
} from '../../server/providers/cellTowers.js';
import {
  iotSensorsProxy,
  iotSourceFromUrl,
  iotViewFromUrl,
  mapOpenSenseBox,
  mapTtnGateway,
  viewToRadius,
} from '../../server/providers/iotSensors.js';
import {
  buildSites,
  csvLine,
  dmsToDecimal,
  supportColumns,
  zipEntries,
} from '../../scripts/build-anfr-towers.mjs';
import { deflateRawSync } from 'node:zlib';

/** Run one provider handler and return the answer it wrote. */
function call(provider, url, { method = 'GET' } = {}) {
  const answer = { status: 0, headers: {}, body: null };
  const res = {
    destroyed: false,
    writeHead(status, headers = {}) {
      answer.status = status;
      answer.headers = headers;
    },
    end(text) {
      answer.body = JSON.parse(text);
    },
  };
  let handler = null;
  provider.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path.startsWith('/api/'), true);
        handler = fn;
      },
    },
  });
  handler({ method, url }, res);
  return new Promise((resolve) => setTimeout(() => resolve(answer), 0));
}

const view = 'west=13.35&south=52.47&east=13.45&north=52.53';

test('a view wider than one request is refused, not forwarded', () => {
  const parse = (query) =>
    cellViewFromUrl(new URL(`/api/cell-towers?${query}`, 'http://x'));
  assert.equal(parse('west=-180&south=-80&east=180&north=80'), null);
  assert.equal(parse('west=2&south=48&east=1&north=49'), null);
  assert.equal(parse('west=2&south=48&east=3&north=49').north, 49);
  assert.equal(
    iotViewFromUrl(new URL(`/api/iot/sensors?${view}`, 'http://x')).west,
    13.35,
  );
  assert.equal(
    iotViewFromUrl(new URL('/api/iot/sensors?west=1', 'http://x')),
    null,
  );
});

test('an unknown provider is refused rather than silently replaced', () => {
  assert.equal(cellSourceFromUrl(new URL('/?source=anfr', 'http://x')), 'anfr');
  assert.equal(cellSourceFromUrl(new URL('/?source=wigle', 'http://x')), null);
  assert.equal(
    cellSourceFromUrl(new URL('/api/cell-towers', 'http://x')),
    'auto',
  );
  assert.equal(
    iotSourceFromUrl(new URL('/api/iot/sensors', 'http://x')),
    'opensensemap',
  );
  assert.equal(
    iotSourceFromUrl(new URL('/api/iot/sensors?source=shodan', 'http://x')),
    null,
  );
});

test('the extract filter keeps what is in view and reports the cap', () => {
  const sites = [
    { id: 'a', lat: 48.85, lon: 2.35 },
    { id: 'b', lat: 43.3, lon: 5.4 },
    { id: 'c', lat: 999, lon: 2.35 },
  ];
  const insideParis = filterSites(sites, {
    west: 2,
    south: 48,
    east: 3,
    north: 49,
  });
  assert.deepEqual(
    insideParis.points.map((site) => site.id),
    ['a'],
  );
  assert.equal(insideParis.truncated, false);
  const capped = filterSites(
    sites,
    { west: -10, south: 0, east: 10, north: 60 },
    1,
  );
  assert.equal(capped.points.length, 1);
  assert.equal(capped.matched, 2);
  assert.equal(capped.truncated, true);
});

test('provider rows become points, or are dropped when they cannot be placed', () => {
  assert.deepEqual(
    mapOpenCellIdCell({
      mcc: 208,
      mnc: 15,
      area: 7,
      cellid: 42,
      lat: 48.8,
      lon: 2.3,
      radio: 'LTE',
    }).id,
    'ocid:208-15-7-42',
  );
  assert.equal(mapOpenCellIdCell({ mcc: 1, lat: 'x', lon: 2 }), null);
  const box = mapOpenSenseBox({
    _id: 'abc',
    name: 'Balcony',
    exposure: 'outdoor',
    currentLocation: { coordinates: [13.4, 52.5] },
    sensors: [{ title: 'PM2.5' }, { title: 'Temperature' }],
  });
  assert.equal(box.id, 'osm:abc');
  assert.equal(box.lat, 52.5);
  assert.deepEqual(box.meta.sensors, ['PM2.5', 'Temperature']);
  assert.equal(
    mapOpenSenseBox({ _id: 'abc', name: 'no position' }),
    null,
    'a box without a published position is not drawn at 0,0',
  );
  assert.equal(
    mapTtnGateway({
      id: 'gw-1',
      location: { latitude: 52.5, longitude: 13.4 },
      online: true,
    }).meta.online,
    true,
  );
  assert.equal(
    mapTtnGateway({ id: 'gw-2', location: { latitude: 0, longitude: 0 } }).lat,
    0,
  );
});

test('the gateway radius covers the view and stays inside the mapper bound', () => {
  const small = viewToRadius({
    west: 13.35,
    south: 52.47,
    east: 13.45,
    north: 52.53,
  });
  assert.ok(small.radius >= 1000 && small.radius <= 100_000);
  const huge = viewToRadius({ west: 0, south: 0, east: 6, north: 6 });
  assert.equal(huge.radius, 333_960 > 100_000 ? 100_000 : huge.radius);
});

test('radio sites answer 503 with a next step when nothing is configured', async () => {
  const provider = cellTowersProxy({
    env: {},
    loadStore: async () => null,
  });
  const answer = await call(provider, '/?west=2&south=48&east=3&north=49');
  assert.equal(answer.status, 503);
  assert.equal(answer.body.error, 'cell_towers_not_configured');
  assert.match(answer.body.hint, /towers:build/);
  assert.match(answer.body.hint, /OPENCELLID_API_KEY/);
});

test('a built extract answers without any key or upstream call', async () => {
  const store = {
    sites: [
      {
        id: 'sup-1',
        lat: 48.85,
        lon: 2.35,
        bands: ['5G'],
        operators: ['Orange'],
      },
      { id: 'sup-2', lat: 43.3, lon: 5.4, bands: [], operators: [] },
    ],
    generatedAt: '2026-10-01T00:00:00Z',
  };
  const provider = cellTowersProxy({
    env: {},
    loadStore: async () => store,
    fetchImpl: async () => {
      throw new Error('the ANFR path must not reach the network');
    },
  });
  const answer = await call(provider, '/?west=2&south=48&east=3&north=49');
  assert.equal(answer.status, 200);
  assert.equal(answer.body.source, 'anfr');
  assert.equal(answer.body.points.length, 1);
  assert.equal(answer.body.points[0].id, 'sup-1');
  assert.equal(answer.body.attribution.licence, 'Licence Ouverte 2.0');
});

test('an OpenCelliD key answers with attributed, mapped cells', async () => {
  const asked = [];
  const provider = cellTowersProxy({
    env: { OPENCELLID_API_KEY: 'test-key' },
    loadStore: async () => null,
    fetchImpl: async (url) => {
      asked.push(url);
      return new Response(
        JSON.stringify({
          count: 1,
          cells: [
            {
              mcc: 208,
              mnc: 15,
              area: 7,
              cellid: 42,
              lat: 48.86,
              lon: 2.35,
              radio: 'LTE',
            },
          ],
        }),
        { status: 200 },
      );
    },
  });
  const answer = await call(provider, '/?west=2&south=48&east=3&north=49');
  assert.equal(answer.status, 200);
  assert.equal(answer.body.source, 'opencellid');
  assert.equal(answer.body.points[0].meta.estimate, true);
  assert.equal(answer.body.attribution.licence, 'CC BY-SA 4.0');
  const request = new URL(asked[0]);
  assert.equal(request.searchParams.get('key'), 'test-key');
  assert.equal(request.searchParams.get('BBOX'), '2,48,3,49');
  assert.equal(request.searchParams.get('limit'), '50');
});

test('connected objects answer both providers from one route', async () => {
  const provider = iotSensorsProxy({
    fetchImpl: async (url) => {
      if (url.includes('packetbroker')) {
        return new Response(
          JSON.stringify([
            {
              id: 'gw-1',
              location: { latitude: 52.5, longitude: 13.4 },
              online: true,
            },
            { id: 'gw-hidden' },
          ]),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify([
          {
            _id: 'box-1',
            name: 'Box',
            currentLocation: { coordinates: [13.4, 52.5] },
            sensors: [{ title: 'PM10' }],
          },
        ]),
        { status: 200 },
      );
    },
  });
  // connect-style mounting strips the route prefix, so handlers see '/?…'.
  const boxes = await call(provider, `/?${view}`);
  assert.equal(boxes.status, 200);
  assert.equal(boxes.body.points.length, 1);
  assert.equal(boxes.body.source, 'opensensemap');
  assert.equal(boxes.body.attribution.licence, 'PDDL 1.0');

  const gateways = await call(provider, `/?${view}&source=ttn`);
  assert.equal(gateways.status, 200);
  assert.equal(
    gateways.body.points.length,
    1,
    'a hidden location is not a 0,0 point',
  );
  assert.equal(gateways.body.source, 'ttn');

  const refused = await call(provider, `/?${view}&source=shodan`);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'unknown_source');
  const method = await call(provider, `/?${view}`, { method: 'POST' });
  assert.equal(method.status, 405);
  assert.equal(method.headers.Allow, 'GET');
});

test('an upstream failure becomes a 502 the panel can explain', async () => {
  const provider = iotSensorsProxy({
    fetchImpl: async () => new Response('nope', { status: 500 }),
  });
  const answer = await call(provider, `/?${view}`);
  assert.equal(answer.status, 502);
  assert.equal(answer.body.error, 'iot_upstream_unavailable');
});

const SUPPORT_HEADER =
  'SUP_ID;STA_NM_ANFR;NAT_ID;COR_NB_DG_LAT;COR_NB_MN_LAT;COR_NB_SC_LAT;COR_CD_NS_LAT;COR_NB_DG_LON;COR_NB_MN_LON;COR_NB_SC_LON;COR_CD_EW_LON;SUP_NM_HAUT;TPO_ID;ADR';
const SUPPORT_ROWS = [
  // Paris: 48°51'12"N 2°21'0"E, one support hosting two stations (two rows).
  'p1;sta-a;23;48;51;12;N;2;21;0;E;41;74;Rue de Paris',
  'p1;sta-b;23;48;51;12;N;2;21;0;E;41;74;Rue de Paris',
  // Marseille: fewer stations on the pylon.
  'm1;sta-c;5;43;18;0;N;5;22;0;E;30;12;Vieux Port',
  // A support without coordinates is not a site.
  'x1;sta-d;5;;;;;N;;;;E;10;12;Nowhere',
];
const TRANSMITTER_HEADER =
  'EMR_ID;EMR_LB_SYSTEME;STA_NM_ANFR;AER_ID;EMR_DT_SERVICE';
const TRANSMITTER_ROWS = [
  '1;5G NR;sta-a;9;2020',
  '2;LTE 1800;sta-a;9;2020',
  '3;FM;sta-c;9;2010',
  '4;5G NR;sta-d;9;2021',
];

const tables = (supports, transmitters = TRANSMITTER_ROWS) => ({
  supportsText: [[SUPPORT_HEADER, ...supports].join('\n')].join(''),
  transmittersText: [[TRANSMITTER_HEADER, ...transmitters].join('\n')].join(''),
});

test('ANFR degrees, minutes, seconds become coordinates; a blank row does not', () => {
  assert.equal(dmsToDecimal('48', '51', '12', 'N').toFixed(5), '48.85333');
  assert.equal(dmsToDecimal('2', '21', '0', 'E').toFixed(5), '2.35000');
  assert.ok(dmsToDecimal('33', '0', '0', 'S') < 0, 'south is negative');
  assert.ok(dmsToDecimal('5', '22', '0', 'W') < 0, 'west is negative');
  assert.equal(dmsToDecimal('', '', '', 'N'), null, 'no degrees, no point');
  assert.equal(
    dmsToDecimal('48', '0', '0', 'Q'),
    null,
    'an unknown hemisphere is not a guess',
  );
});

test('the support table is read by column name, never by position', () => {
  const columns = supportColumns(SUPPORT_HEADER.split(';'));
  assert.equal(columns.id, 0);
  assert.equal(columns.station, 1);
  assert.equal(columns.dgLat, 3);
  assert.equal(columns.dgLon, 7);
  assert.equal(columns.address, 13);
});

test('one point per support, with the systems transmitting from it', () => {
  const { sites, supportsRead } = buildSites(tables(SUPPORT_ROWS));
  // Two rows for p1 (one per station) and one for m1; the blank-coordinate
  // support is not counted.
  assert.equal(supportsRead, 3, 'only rows with coordinates are read');
  assert.equal(sites.length, 2, 'two stations on one pylon are one site');
  assert.deepEqual(sites[0].bands, ['5G NR', 'LTE 1800']);
  assert.equal(sites[0].lat, 48.85333);
  assert.equal(sites[0].address, 'Rue de Paris');
  assert.deepEqual(sites[1].bands, ['FM']);
});

test('a regional extract keeps only the requested box', () => {
  const { sites } = buildSites({
    ...tables(SUPPORT_ROWS),
    bbox: [2, 48, 3, 49],
  });
  assert.equal(sites.length, 1);
  assert.equal(sites[0].id, 'p1');
});

test('a support table without the documented columns is refused, not half-read', () => {
  assert.throws(
    () => buildSites({ supportsText: 'SUP_ID;SUP_LAT\np1;48.85' }),
    /DMS coordinate columns/,
  );
});

test('CSV quoting and ZIP entries survive a round trip', () => {
  assert.deepEqual(csvLine('a;"b;c";d'), ['a', 'b;c', 'd']);
  assert.deepEqual(csvLine('"he said ""hi"""'), ['he said "hi"']);

  // A one-entry ZIP, stored and deflated, built by hand so the reader is
  // exercised on the two methods data.gouv archives actually use.
  const build = (method, payload) => {
    const name = Buffer.from('table.csv');
    const data = method === 0 ? Buffer.from(payload) : deflateRawSync(payload);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(payload.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(0, 42);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(directory.length + name.length, 12);
    const directoryOffset = local.length + name.length + data.length;
    end.writeUInt32LE(directoryOffset, 16);
    return Buffer.concat([local, name, data, directory, name, end]);
  };
  for (const method of [0, 8]) {
    const entries = zipEntries(build(method, 'SUP_LAT\n48.85\n'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'table.csv');
    assert.equal(entries[0].read().toString('utf8'), 'SUP_LAT\n48.85\n');
  }
});
