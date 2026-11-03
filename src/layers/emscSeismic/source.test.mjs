import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEmscQueryUrl,
  createEmscEarthquakeSource,
  fdsnFormatInstant,
} from './source.js';

test('fdsnFormatInstant strips milliseconds and offsets', () => {
  assert.equal(
    fdsnFormatInstant(new Date('2026-11-03T05:40:17.688Z')),
    '2026-11-03T05:40:17',
  );
  assert.equal(fdsnFormatInstant(new Date(0)), '1970-01-01T00:00:00');
});

test('buildEmscQueryUrl targets the 24h M2.5+ json window for the requested moment', () => {
  const now = Date.parse('2026-11-03T08:00:00.000Z');
  const url = buildEmscQueryUrl({ now: new Date(now) });
  const parsed = new URL(url);
  assert.equal(
    `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
    'https://www.seismicportal.eu/fdsnws/event/1/query',
  );
  assert.equal(parsed.searchParams.get('format'), 'json');
  assert.equal(parsed.searchParams.get('minmagnitude'), '2.5');
  assert.equal(parsed.searchParams.get('limit'), '1500');
  assert.equal(parsed.searchParams.get('starttime'), '2026-11-02T08:00:00');
  assert.equal(parsed.searchParams.get('endtime'), '2026-11-03T08:00:00');
});

test('createEmscEarthquakeSource validates a parsed feed, accepts 204 as empty, and rejects failures', async () => {
  const good = feat => ({
    type: 'FeatureCollection',
    features: [feat],
  });
  const feature = {
    id: 'u1',
    geometry: { type: 'Point', coordinates: [5, 5, -3] },
    properties: { mag: 4, unid: 'u1', time: '2026-11-03T05:40:17Z', lat: 5, lon: 5, depth: 3 },
  };

  const journeys = [
    {
      name: 'feed from server',
      send: { status: 200, body: good(feature) },
    },
    {
      name: 'empty window (204)',
      send: { status: 204 },
    },
    {
      name: 'HTTP failures',
      send: { status: 502, body: {} },
      rejects: new RegExp('502'),
    },
    {
      name: 'malformed body',
      send: { status: 200, body: { features: null } },
      rejects: new RegExp('Malformed'),
    },
  ];

  const row = {
    stableId: 'u1',
    emscId: 'u1',
    lon: 5,
    lat: 5,
    depthKm: 3,
    mag: 4,
    place: null,
    time: Date.parse('2026-11-03T05:40:17Z'),
    magtype: null,
  };

  for (const journey of journeys) {
    const fetches = [];
    const source = createEmscEarthquakeSource({
      now: () => new Date(Date.parse('2026-11-03T08:00:00.000Z')),
      fetchImpl: (url) => {
        fetches.push(url);
        return Promise.resolve({
          ok: journey.send.status === 200 || journey.send.status === 204,
          status: journey.send.status,
          json: async () => journey.send.body,
        });
      },
    });

    if (journey.rejects) {
      await assert.rejects(source.getSnapshot(), journey.rejects, journey.name);
    } else if (journey.send.status >= 200 && journey.send.status < 300) {
      const rows = await source.getSnapshot();
      assert.equal(fetches.length, 1, journey.name);
      if (journey.send.status === 204) {
        assert.deepEqual(rows, [], journey.name);
      } else {
        assert.deepEqual(rows, [row], journey.name);
      }
    } else {
      await assert.rejects(
        source.getSnapshot(),
        new RegExp(`${journey.send.status}|Malformed`),
        journey.name,
      );
    }
  }
});
