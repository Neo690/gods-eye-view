import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachCycloneGeometry,
  cycloneGeometryUrls,
  describeCycloneSnapshot,
  parseCycloneStatus,
} from './cycloneStorms.js';
import {
  attachCycloneGeometry as serverAttach,
  parseCycloneStatus as serverParse,
} from '../../server/providers/cyclones.js';

const NOW = Date.UTC(2026, 9, 23, 18, 0, 0);
const at = (ms) => new Date(NOW - ms).toISOString();

const status = {
  activeStorms: [
    {
      id: 'al092026',
      name: 'Tropical Storm Test',
      classification: 'TS',
      longitudeNumeric: -55.2,
      latitudeNumeric: 22.4,
      lastUpdate: at(60 * 60_000),
      intensity: 45,
      pressure: 1002,
      movementDir: 300,
      movementSpeed: 12,
      forecastAdvisory: {
        advNum: '09',
        issuance: at(2 * 60 * 60_000),
        url: 'https://www.nhc.noaa.gov/text/AL092026.shtml',
      },
    },
  ],
};

const feature = (kind, properties, geometry) => ({
  type: 'Feature',
  properties,
  geometry,
});

const collections = [
  {
    type: 'FeatureCollection',
    features: [
      feature(
        'pts',
        {
          idp_source: 'al092026-009_5day_pts',
          advisnum: '9',
          tau: '12',
          maxwind: '40',
          gust: '50',
        },
        { type: 'Point', coordinates: [-54.1, 23.1] },
      ),
    ],
  },
  {
    type: 'FeatureCollection',
    features: [
      feature(
        'lin',
        { idp_source: 'al092026-009_5day_lin', advisnum: '9' },
        {
          type: 'LineString',
          coordinates: [
            [-55.2, 22.4],
            [-54.1, 23.1],
          ],
        },
      ),
    ],
  },
  {
    type: 'FeatureCollection',
    features: [
      feature(
        'pgn',
        { idp_source: 'al092026-009_5day_pgn', advisnum: '9' },
        {
          type: 'Polygon',
          coordinates: [
            [
              [-56, 21.5],
              [-53, 21.5],
              [-53, 24],
              [-56, 21.5],
            ],
          ],
        },
      ),
    ],
  },
];

test('the client builder produces the server’s storm list', () => {
  const mine = parseCycloneStatus(status, NOW);
  const theirs = serverParse(status, NOW);
  assert.deepEqual(mine, theirs);
  assert.equal(mine[0].advisoryNumber, '9');
  assert.equal(mine[0].basin, 'AL');
  assert.equal(mine[0].geometryStatus, 'pending');
});

test('the geometry attachment matches the server too', () => {
  const mine = attachCycloneGeometry(parseCycloneStatus(status, NOW), collections);
  const theirs = serverAttach(serverParse(status, NOW), collections);
  assert.deepEqual(mine, theirs);
  assert.equal(mine[0].geometryStatus, 'current');
  assert.equal(mine[0].forecastPoints.length, 1);
  assert.equal(mine[0].forecastPoints[0].tauHours, 12);
  assert.equal(mine[0].track.type, 'LineString');
  assert.equal(mine[0].cone.type, 'Polygon');
});

test('an unknown storm or a mismatched advisory stays pending', () => {
  const other = collections.map((collection) => ({
    ...collection,
    features: collection.features.map((item) => ({
      ...item,
      properties: {
        ...item.properties,
        idp_source: item.properties.idp_source.replace('al092026', 'ep072026'),
      },
    })),
  }));
  const storms = attachCycloneGeometry(parseCycloneStatus(status, NOW), other);
  assert.equal(storms[0].geometryStatus, 'pending');
});

test('an expired advisory is refused', () => {
  const old = {
    activeStorms: [{ ...status.activeStorms[0], lastUpdate: at(20 * 60 * 60_000) }],
  };
  assert.throws(() => parseCycloneStatus(old, NOW));
});

test('the document carries the layer’s provenance fields', () => {
  const storms = attachCycloneGeometry(parseCycloneStatus(status, NOW), collections);
  const doc = describeCycloneSnapshot({ storms, fetchedAt: NOW });
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.source, 'NOAA NHC / CPHC');
  assert.equal(doc.unavailable, false);
  assert.equal(doc.stale, false);
  assert.equal(doc.reason, null);
  assert.equal(doc.storms.length, 1);
  const unavailable = describeCycloneSnapshot(null);
  assert.equal(unavailable.unavailable, true);
  assert.equal(unavailable.storms.length, 0);
});

test('the GIS queries ask for the three published layers', () => {
  const urls = cycloneGeometryUrls();
  assert.equal(urls.length, 3);
  for (const [index, id] of ['5', '6', '7'].entries()) {
    assert.match(urls[index], new RegExp(`/MapServer/${id}/query`));
    assert.match(urls[index], /f=geojson/);
  }
});
