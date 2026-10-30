import test from 'node:test';
import assert from 'node:assert/strict';
import { createSatelliteWatchSource } from './sources.js';

const MEMBER = (id) => ({
  satelliteId: id,
  name: `SAT ${id}`,
  line1:
    '1 25544U 98067A   24001.50000000  .00016717  00000+0  30777-3 0  9993',
  line2:
    '2 25544  51.6416  90.5085 0004526  90.7038  51.2835 15.49512600  1234',
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    headers: { get: () => null },
  };
}

test('the TLE catalogue merges its pages', async () => {
  const asked = [];
  const source = createSatelliteWatchSource({
    tleApiPages: 3,
    fetchImpl: async (url) => {
      asked.push(url);
      const page = Number(url.split('/').pop());
      return jsonResponse({ member: [MEMBER(page), MEMBER(page + 10)] });
    },
  });
  const { members } = await source.readTleApi({});
  assert.equal(asked.length, 3);
  assert.equal(members.length, 6);
  assert.deepEqual(asked, [
    '/api/tle-catalogue/1',
    '/api/tle-catalogue/2',
    '/api/tle-catalogue/3',
  ]);
});

test('one failed page costs its own objects, not the source', async () => {
  let call = 0;
  const source = createSatelliteWatchSource({
    tleApiPages: 3,
    fetchImpl: async () => {
      call++;
      if (call === 2) throw new Error('deadline');
      return jsonResponse({ member: [MEMBER(call)] });
    },
  });
  const { members } = await source.readTleApi({});
  assert.equal(members.length, 2);
});

test('every page failing reports the source, not an empty answer', async () => {
  const source = createSatelliteWatchSource({
    tleApiPages: 2,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  await assert.rejects(() => source.readTleApi({}), /Catalogue unavailable/);
});

test('CelesTrak groups merge by NORAD and survive one bad group', async () => {
  const source = createSatelliteWatchSource({
    fetchImpl: async (url) => {
      if (url.endsWith('/visual')) throw new Error('down');
      if (url.endsWith('/gps-ops'))
        return {
          ok: true,
          status: 200,
          text: async () =>
            [
              'GPSSAT',
              '1 43013U 17073A   24001.50000000  .00000123  00000+0  10245-4 0  9994',
              '2 43013  98.7200 120.1000 0001200  90.0000 270.0000 14.19512300  1234',
            ].join('\n'),
          headers: { get: () => null },
        };
      return {
        ok: true,
        status: 200,
        text: async () =>
          [
            'ISS (ZARYA)',
            '1 25544U 98067A   24001.50000000  .00016717  00000+0  30777-3 0  9993',
            '2 25544  51.6416  90.5085 0004526  90.7038  51.2835 15.49512600  1234',
          ].join('\n'),
        headers: { get: () => null },
      };
    },
  });
  const { entries } = await source.readCatalog({});
  assert.deepEqual(entries.map((entry) => entry.norad).sort(), [
    '25544',
    '43013',
  ]);
});

test('the previous generation is read per group and a cold cache costs nothing', async () => {
  const asked = [];
  const source = createSatelliteWatchSource({
    groups: ['stations', 'geo'],
    fetchImpl: async (url) => {
      asked.push(url);
      if (url.endsWith('/geo'))
        return {
          ok: false,
          status: 404,
          body: { cancel: async () => {} },
          headers: { get: () => null },
        };
      return {
        ok: true,
        status: 200,
        text: async () =>
          [
            'ISS (ZARYA)',
            '1 25544U 98067A   24000.50000000  .00016717  00000+0  30777-3 0  9993',
            '2 25544  51.6416  90.5085 0004526  90.7038  51.2835 15.48000000  1234',
          ].join('\n'),
        headers: { get: () => null },
      };
    },
  });
  const { entries } = await source.readPreviousCatalog({});
  assert.deepEqual(asked, [
    '/api/celestrak/previous/stations',
    '/api/celestrak/previous/geo',
  ]);
  assert.deepEqual(
    entries.map((entry) => entry.norad),
    ['25544'],
  );
});

test('Space-Track element sets and conjunctions come from one authenticated pair of routes', async () => {
  const asked = [];
  const source = createSatelliteWatchSource({
    fetchImpl: async (url) => {
      asked.push(url);
      if (url.startsWith('/api/spacetrack/gp'))
        return jsonResponse({
          fetchedAt: 1,
          stale: true,
          entries: [
            { norad: '25544', name: 'ISS', line1: '1 x', line2: '2 x' },
          ],
        });
      return jsonResponse({
        fetchedAt: 1,
        messages: [{ CDM_ID: 1, SAT_1_ID: 25544, TCA: '2026-01-02 00:00:00' }],
      });
    },
  });
  const answer = await source.readSpaceTrack({});
  assert.equal(answer.ok, true);
  assert.equal(answer.stale, true);
  assert.equal(answer.entries.length, 1);
  assert.equal(answer.messages.length, 1);
  assert.deepEqual(asked, ['/api/spacetrack/gp', '/api/spacetrack/cdm']);
});

test('a deployment without Space-Track credentials reads as a missing account', async () => {
  const source = createSatelliteWatchSource({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'no_key' }),
      body: { cancel: async () => {} },
      headers: { get: () => null },
    }),
  });
  const answer = await source.readSpaceTrack({});
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'missing-key');
  assert.deepEqual(answer.entries, []);
});

test('N2YO asks the app route with the observer point, never with a key', async () => {
  const asked = [];
  const source = createSatelliteWatchSource({
    fetchImpl: async (url) => {
      asked.push(url);
      return jsonResponse({
        info: { satcount: 1 },
        above: [
          { satid: 25544, satname: 'ISS', satlat: 1, satlng: 2, satalt: 419 },
        ],
      });
    },
  });
  const answer = await source.readN2yo({
    lat: 48.85,
    lon: 2.35,
    radiusDeg: 70,
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.above.length, 1);
  assert.equal(asked[0], '/api/n2yo/above?lat=48.85&lon=2.35&radius=70');
});

test('a deployment without the N2YO key reads as a missing key, not an outage', async () => {
  const source = createSatelliteWatchSource({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'no_key' }),
      body: { cancel: async () => {} },
      headers: { get: () => null },
    }),
  });
  const answer = await source.readN2yo({ lat: 0, lon: 0 });
  assert.equal(answer.ok, false);
  assert.equal(answer.error, 'missing-key');
  assert.deepEqual(answer.above, []);
});
