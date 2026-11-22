import test from 'node:test';
import assert from 'node:assert/strict';

import { patrolSitesFromRecords } from './patrolSites.js';

const records = [
  { id: 'osm:node:91001', name: 'Creil', latitude: 49.253, longitude: 2.519 },
  {
    id: 'osm:node:91002',
    name: 'Villacoublay',
    latitude: 48.774,
    longitude: 2.191,
  },
];

test('the layer hands the patrol its records as positioned sites', () => {
  assert.deepEqual(patrolSitesFromRecords(records), [
    {
      id: 'osm:node:91001',
      label: 'Creil',
      latitude: 49.253,
      longitude: 2.519,
    },
    {
      id: 'osm:node:91002',
      label: 'Villacoublay',
      latitude: 48.774,
      longitude: 2.191,
    },
  ]);
});

test('a record with no usable position is left out, not planted at 0,0', () => {
  const sites = patrolSitesFromRecords([
    { id: 'no-lat', name: 'nowhere', latitude: null, longitude: 2.35 },
    { id: 'no-lon', name: 'nowhere', latitude: 48.85, longitude: null },
    { id: 'nan', name: 'nowhere', latitude: Number.NaN, longitude: 2.35 },
    { id: 'empty', name: 'nowhere', latitude: '', longitude: '' },
    ...records,
  ]);
  assert.deepEqual(
    sites.map((site) => site.id),
    ['osm:node:91001', 'osm:node:91002'],
    'only the rows the layer can actually draw become targets',
  );
});

test('an unreadable cap still reads the catalog', () => {
  const ids = (maxCount) =>
    patrolSitesFromRecords(records, maxCount).map((site) => site.id);
  assert.deepEqual(ids(1), ['osm:node:91001'], 'the cap bounds the walk');
  assert.deepEqual(
    ids(0),
    ['osm:node:91001'],
    'a zero cap asks for one, not for none',
  );
  assert.equal(ids(Number.NaN).length, records.length);
  assert.deepEqual(patrolSitesFromRecords(null), []);
});
