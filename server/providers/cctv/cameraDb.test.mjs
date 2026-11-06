import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CAMERA_MODELS_FILE,
  joinCameraModels,
  loadCameraModels,
  matchCameraModel,
} from './cameraDb.js';
import { normalizeSourceItem } from './normalize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED_INDEX = path.resolve(
  HERE,
  '../../../src/data/local_data/cctv_camera_models/cctv_camera_models.json',
);

/**
 * Install an index file and load it through the file-path override the
 * loader reads (the same way an operator would point the join at another
 * build), returning it plus its cleanup.
 * @param {object|string} written Object written to the file, or raw text.
 */
function installed(written) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'camera-models-')),
    'cctv_camera_models.json',
  );
  fs.writeFileSync(
    file,
    typeof written === 'string' ? written : JSON.stringify(written),
  );
  process.env.CCTV_CAMERA_MODELS_FILE = file;
  return {
    file,
    db: loadCameraModels(process.cwd()),
    cleanup: () => {
      delete process.env.CCTV_CAMERA_MODELS_FILE;
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    },
  };
}

/**
 * Fixture index: a numbered Cohu series (one exact, one series-only), a key
 * shared by two brands (ambiguous, confirms nothing), and a multi-word brand
 * the peel has to take as one unit.
 */
function fixture() {
  return installed({
    schemaVersion: 1,
    source: 'ch-bas/cctv-camera-database',
    license: 'CC0-1.0',
    cameraCount: 4,
    brandCount: 3,
    brands: ['Cohu', 'TelaVision Works'],
    brandNorm: ['cohu', 'telavision works'],
    lookup: {
      '3960': [{ brand: 'Cohu', model: '3960', id: 'cohu-3960' }],
      'megacam x1': [
        { brand: 'TelaVision Works', model: 'MegaCam X1', id: 'tela-mx1' },
      ],
      servecam: [
        { brand: 'TelaVision Works', model: 'ServeCam', id: 'tela-servecam' },
      ],
      'x2 servecam': [
        { brand: 'TelaVision Works', model: 'ServeCam X2', id: 'tela-servecam-x2' },
      ],
      duplex: [
        { brand: 'Cohu', model: 'Duplex', id: 'cohu-duplex' },
        { brand: 'TelaVision Works', model: 'Duplex', id: 'tela-duplex' },
      ],
    },
    series: {
      '3950': [{ brand: 'Cohu', model: '3950 iVIEW', id: 'cohu-3950-iview' }],
    },
  });
}

test('the loader needs a parseable lookup; failures leave the cache cold', () => {
  const first = installed({ no: 'lookup' });
  try {
    assert.equal(first.db, null);
    fs.writeFileSync(first.file, '{not json');
    assert.equal(loadCameraModels(process.cwd()), null);
    // Malformed rows are dropped; an empty-but-valid lookup still loads.
    fs.writeFileSync(
      first.file,
      JSON.stringify({
        cameraCount: 1,
        lookup: { '3960': [null, { brand: 'Cohu', model: '3960', id: 'x' }] },
        brandNorm: ['cohu'],
        series: {},
      }),
    );
    const db = loadCameraModels(process.cwd());
    assert.deepEqual([...db.lookup.get('3960')], [
      { brand: 'Cohu', model: '3960', id: 'x' },
    ]);
    assert.deepEqual([...db.series.keys()], []);
  } finally {
    first.cleanup();
  }
});

test('the committed index loads and names the CC0 dataset it came from', () => {
  process.env.CCTV_CAMERA_MODELS_FILE = COMMITTED_INDEX;
  try {
    const db = loadCameraModels(process.cwd());
    assert.ok(db, 'the committed index parses');
    assert.match(db.meta.source, /cctv-camera-database/);
    assert.equal(db.meta.license, 'CC0-1.0');
    assert.ok(db.meta.cameraCount > 29000, String(db.meta.cameraCount));
    // Hardware the camera packs publish is covered: Cohu's numbered series,
    // Bosch's AutoDome line, an Axis dome model.
    assert.equal(db.lookup.get('3960')?.[0].id, 'cohu-3960');
    assert.ok(db.lookup.get('autodome ip 4000 hd'), 'Bosch AUTODOME IP 4000 HD');
    assert.ok(db.lookup.get('axis p3225 lv') || db.lookup.get('p3225 lv'),
      'Axis P3225-LV');
    // The series tier King County's bare series numbers rely on.
    assert.equal(db.series.get('3950')?.[0].id, 'cohu-3950-iview');
    // The brand-agreement rule on the real dataset: "AXIS Q61" must not land
    // on ACTi's own "Q61" row, while the full Axis model still does.
    assert.equal(matchCameraModel(db, 'AXIS Q61'), null);
    assert.match(matchCameraModel(db, 'AXIS P3225-LV')?.id ?? '', /axis/);
  } finally {
    delete process.env.CCTV_CAMERA_MODELS_FILE;
  }
});

test('matchCameraModel: exact, peeled brand, series and refusals', () => {
  const { db, cleanup } = fixture();
  try {
    assert.deepEqual(matchCameraModel(db, '3960'), {
      brand: 'Cohu',
      model: '3960',
      id: 'cohu-3960',
      match: 'exact',
    });
    // A leading brand word is peeled; the remainder names exactly one row.
    assert.deepEqual(matchCameraModel(db, 'Cohu 3960'), {
      brand: 'Cohu',
      model: '3960',
      id: 'cohu-3960',
      match: 'exact',
    });
    // Case and punctuation fold to the same key.
    assert.match(matchCameraModel(db, 'COHU 3960?')?.id ?? '', /cohu-3960/);
    // A multi-word brand peels as one unit, and the resolved row is that
    // same brand's hardware.
    assert.deepEqual(matchCameraModel(db, 'TelaVision Works MegaCam X1'), {
      brand: 'TelaVision Works',
      model: 'MegaCam X1',
      id: 'tela-mx1',
      match: 'exact',
    });
    // Series tier: the feed's bare series number names the longer title the
    // dataset records after it.
    assert.deepEqual(matchCameraModel(db, 'Cohu 3950'), {
      brand: 'Cohu',
      model: '3950 iVIEW',
      id: 'cohu-3950-iview',
      match: 'series',
    });
    assert.deepEqual(matchCameraModel(db, '3950'), {
      brand: 'Cohu',
      model: '3950 iVIEW',
      id: 'cohu-3950-iview',
      match: 'series',
    });
    // Nothing to name.
    assert.equal(matchCameraModel(db, 'UltraCam 9000'), null);
    assert.equal(matchCameraModel(db, ''), null);
    assert.equal(matchCameraModel(db, 'Cohu'), null);
    assert.equal(matchCameraModel(null, '3960'), null);
    // An ambiguous key names no hardware.
    assert.equal(matchCameraModel(db, 'Duplex'), null);
    // A string that names a brand is refused when the resolved row is
    // another maker's hardware: the string's own brand wins over the bare
    // remainder, and refusing is the only honest answer.
    assert.equal(matchCameraModel(db, 'Cohu ServeCam'), null);
    // A series number the dataset does not list invents nothing: "3961" is
    // next to "3960", still unknown.
    assert.equal(matchCameraModel(db, '3961'), null);
    // Three-character candidates are okay when one row holds the key.
    assert.equal(matchCameraModel(db, 'ServeCam')?.id, 'tela-servecam');
    // Two-character candidates are too collision-prone.
    assert.equal(matchCameraModel(db, 'X1'), null);
  } finally {
    cleanup();
  }
});

test('joinCameraModels fills a missing manufacturer and never overwrites', () => {
  const { db, cleanup } = fixture();
  try {
    const sources = joinCameraModels(
      [
        // King County shape: both columns published.
        normalizeSourceItem({
          id: 'kc-1',
          model: 'Cohu 3960',
          manufacturer: 'COHU',
        }),
        // The case the join exists for: model, no manufacturer.
        normalizeSourceItem({ id: 'kc-2', model: '3950' }),
        // A feed's generic model the dataset shadows only ambiguously: no
        // manufacturer for it to fill, no ref.
        normalizeSourceItem({ id: 'kc-3', model: 'Duplex' }),
        // No model at all: untouched.
        normalizeSourceItem({ id: 'kc-4' }),
      ],
      db,
    );
    assert.equal(sources[0].model, 'Cohu 3960', 'feed wording kept');
    assert.equal(sources[0].manufacturer, 'COHU', 'feed wording kept');
    assert.equal(sources[0].modelRef, 'cohu-3960');
    assert.equal(sources[0].modelMatch, 'exact');

    assert.equal(
      sources[1].manufacturer,
      'Cohu',
      'filled from the dataset',
    );
    assert.equal(sources[1].modelRef, 'cohu-3950-iview');
    assert.equal(sources[1].modelMatch, 'series');

    assert.equal(sources[2].modelRef, undefined, 'ambiguous key adds nothing');
    assert.equal(sources[2].manufacturer, undefined);
    assert.equal(sources[3].modelRef, undefined);
    assert.equal(sources[3].manufacturer, undefined);
  } finally {
    cleanup();
  }
});

test('joinCameraModels is a no-op without an index', () => {
  const sources = [normalizeSourceItem({ id: 'kc-1', model: '3960' })];
  assert.equal(joinCameraModels(sources, null), sources);
  assert.equal(sources[0].modelRef, undefined);
  assert.equal(joinCameraModels(null, null), null);
});
