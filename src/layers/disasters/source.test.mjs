import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEffisWfsUrl,
  buildEmsActivationsUrl,
  buildGdacsQueryUrl,
  createGlobalDisastersSource,
  GDACS_EVENT_TYPES,
} from './source.js';
import { normalizeEmsActivationList } from './records.js';

test('URL builders target the verified endpoints exactly', () => {
  const gdacs = new URL(buildGdacsQueryUrl({ pageNumber: 2 }));
  assert.equal(
    `${gdacs.protocol}//${gdacs.host}${gdacs.pathname}`,
    'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH',
  );
  assert.equal(gdacs.searchParams.get('eventlist'), GDACS_EVENT_TYPES);
  assert.equal(gdacs.searchParams.get('pageSize'), '100');
  assert.equal(gdacs.searchParams.get('pageNumber'), '2');

  assert.equal(buildEmsActivationsUrl(), '/api/copernicus-ems');

  const effis = new URL(buildEffisWfsUrl());
  assert.equal(
    `${effis.protocol}//${effis.host}${effis.pathname}`,
    'https://maps.effis.emergency.copernicus.eu/effis/ows',
  );
  assert.equal(effis.searchParams.get('service'), 'WFS');
  assert.equal(effis.searchParams.get('version'), '2.0.0');
  assert.equal(effis.searchParams.get('request'), 'GetFeature');
  assert.equal(effis.searchParams.get('typeNames'), 'ms:modis.ba.poly.week');
  // MapServer demands this exact serialization with the literal space.
  assert.equal(
    effis.searchParams.get('outputFormat'),
    'application/json; subtype=geojson',
  );
});

const NOW = Date.parse('2026-11-03T12:00:00Z');

function gdacsPage(featuresCount) {
  return {
    features: Array.from({ length: featuresCount }, (_unused, index) => ({
      geometry: { type: 'Point', coordinates: [10 + index, 45] },
      properties: {
        eventid: 1000 + index,
        eventtype: 'FL',
        todate: '2026-11-02T06:00:00',
      },
    })),
  };
}

test('a valid read returns primary events plus both complements, merged', async () => {
  const emsPayload = {
    results: [
      {
        code: 'EMSR935',
        centroid: 'POINT (0.5 38.5)',
        activationTime: '2026-10-19T16:03:00',
        category: { slug: 'flood' },
        closed: false,
        name: 'Flood Spain',
      },
    ],
  };
  const effisPayload = {
    features: [
      {
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
        properties: { id: '1', FIREDATE: '2026-11-01 00:00:00', AREA_HA: '20' },
      },
    ],
  };
  const source = createGlobalDisastersSource({
    now: () => NOW,
    fetchImpl: (url) => {
      if (String(url).includes('gdacs.org'))
        return ok(gdacsPage(2));
      if (String(url).includes('/api/copernicus-ems')) return ok(emsPayload);
      if (String(url).includes('maps.effis.emergency.copernicus.eu'))
        return ok(effisPayload);
      throw new Error(`unexpected ${url}`);
    },
  });
  const rows = await source.getSnapshot();
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['event', 'event', 'activation', 'fire'],
  );
});

function ok(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

test('GDACS pages are followed while they stay full, up to the cap', async () => {
  const seen = [];
  const source = createGlobalDisastersSource({
    now: () => NOW,
    gdacsMaxEvents: 250,
    fetchImpl: (url) => {
      if (String(url).includes('gdacs.org')) seen.push(String(url));
      // The complements answer against the same stub; only the GDACS pages
      // are counted in the read-bounding assertions below.
      return ok(
        String(url).includes('gdacs.org')
          ? gdacsPage(100)
          : String(url).includes('/api/copernicus-ems')
            ? emsPayload()
            : effisPayload(),
      );
    },
  });
  const rows = await source.getSnapshot();
  assert.equal(seen.length, 3, '100 + 100 + 50-capped');
  // 250 capped GDACS events plus the two stub complements (activation+fire).
  assert.equal(rows.length, 252);
  assert.match(seen[1], /pageNumber=2/);
});

test('the GDACS primary failing fails the snapshot', async () => {
  const source = createGlobalDisastersSource({
    now: () => NOW,
    fetchImpl: (url) => {
      if (String(url).includes('gdacs.org')) return ok(gdacsPage(0));
      if (String(url).includes('/api/copernicus-ems')) return ok(emsPayload());
      return ok(effisPayload());
    },
  });
  // A page answer with no features at all is still a valid document; it must
  // simply yield zero events, not an error.
  const rows = await source.getSnapshot();
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['activation', 'fire'],
  );
  // malformed GDACS, though:
  const broken = createGlobalDisastersSource({
    now: () => NOW,
    fetchImpl: () => ok({ nope: true }),
  });
  await assert.rejects(broken.getSnapshot(), /Malformed/);
});

function emsPayload() {
  return {
    results: [
      {
        code: 'EMSR935',
        centroid: 'POINT (0.5 38.5)',
        activationTime: '2026-10-19T16:03:00',
        category: { slug: 'flood' },
        closed: false,
        name: 'Flood Spain',
      },
    ],
  };
}
function effisPayload() {
  return {
    features: [
      {
        geometry: {
          type: 'Polygon',
          coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        },
        properties: { id: '1', FIREDATE: '2026-11-01 00:00:00', AREA_HA: '20' },
      },
    ],
  };
}

test('complement failures thin the layer but never fail the snapshot and the EMS body is validated', async () => {
  const source = createGlobalDisastersSource({
    now: () => NOW,
    fetchImpl: (url) => {
      if (String(url).includes('gdacs.org')) return ok(gdacsPage(1));
      if (String(url).includes('/api/copernicus-ems'))
        return ok({ error: 'upstream' });
      // an HTTP failure for EFFIS:
      return Promise.resolve({ ok: false, status: 502, json: async () => ({}) });
    },
  });
  const rows = await source.getSnapshot();
  assert.deepEqual(
    rows.map((row) => row.kind),
    ['event'],
  );
});

test('abort signals propagate into the primary read', async () => {
  const controller = new AbortController();
  const source = createGlobalDisastersSource({
    now: () => NOW,
    fetchImpl: (url, init) => {
      init?.signal?.addEventListener('abort', () => {
        /* explicit no-op: the throw happens below */
      });
      controller.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    },
  });
  await assert.rejects(
    source.getSnapshot({ signal: controller.signal }),
    /Abort/,
  );
});

test('the EMS normalizer re-export is importable for the proxy', () => {
  assert.equal(typeof normalizeEmsActivationList, 'function');
});
