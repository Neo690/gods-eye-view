import assert from 'node:assert/strict';
import test from 'node:test';

import { datasetModelRef, modelRefToken } from './modelReference.js';
import { createPresentation } from './presentation.js';
import { setLocale, t } from '../../i18n/index.js';

test('a confirmed dataset row and grade are surfaced', () => {
  assert.deepEqual(
    datasetModelRef({ modelRef: 'axis-q6155-e', modelMatch: 'exact' }),
    {
      ref: 'axis-q6155-e',
      match: 'exact',
    },
  );
  assert.deepEqual(
    datasetModelRef({ modelRef: 'cohu-3950-iview', modelMatch: 'series' }),
    { ref: 'cohu-3950-iview', match: 'series' },
  );
});

test('a malformed ref, an unknown grade or no confirmation reads as none', () => {
  const none = [
    {},
    { modelRef: 'axis-q6155-e' },
    { modelMatch: 'exact' },
    { modelRef: 'Axis Q6155-E', modelMatch: 'exact' },
    { modelRef: 'axis--q6155', modelMatch: 'exact' },
    { modelRef: 'axis-q6155-e', modelMatch: 'family' },
    { modelRef: '   ', modelMatch: 'exact' },
    { modelRef: ['axis-q6155-e'], modelMatch: 'exact' },
  ];
  for (const camera of none) {
    assert.equal(datasetModelRef(camera), null, JSON.stringify(camera));
    assert.equal(modelRefToken(camera), null, JSON.stringify(camera));
  }
});

test('the token names the row and grades the match, English by default', () => {
  assert.equal(
    modelRefToken({ modelRef: 'axis-q6155-e', modelMatch: 'exact' }),
    'MODEL AXIS-Q6155-E (DATASET EXACT)',
  );
  assert.equal(
    modelRefToken({ modelRef: 'cohu-3950-iview', modelMatch: 'series' }),
    'MODEL COHU-3950-IVIEW (DATASET SERIES)',
  );
});

test('the HUD grades a confirmed row in the active locale', () => {
  setLocale('fr');
  try {
    const format = (ref, match) =>
      match === 'series'
        ? t('MODEL {ref} (DATASET SERIES)', { ref })
        : t('MODEL {ref} (DATASET EXACT)', { ref });
    assert.equal(
      modelRefToken({ modelRef: 'axis-q6155-e', modelMatch: 'exact' }, format),
      'MODÈLE AXIS-Q6155-E (JEU DE DONNÉES · EXACT)',
    );
    assert.equal(
      modelRefToken(
        { modelRef: 'cohu-3950-iview', modelMatch: 'series' },
        format,
      ),
      'MODÈLE COHU-3950-IVIEW (JEU DE DONNÉES · SÉRIE)',
    );
  } finally {
    setLocale('en');
  }
});

test('the panel summary carries the dataset token beside the source', () => {
  const camera = {
    id: 'kingcounty-56',
    name: 'Test cam',
    city: 'Seattle',
    cityId: 'seattle',
    provider: 'King County',
    lat: 47.7,
    lon: -122.02,
    headingDeg: 0,
    headingConfidence: 'high',
    fovDeg: 60,
    rangeM: 400,
    pitchDeg: -10,
    feedType: 'image',
    sourceKind: 'kingcounty-open-data',
    model: 'Q6135-LE',
    manufacturer: 'Axis',
    modelRef: 'axis-q6135-le',
    modelMatch: 'exact',
  };
  const record = { camera };
  const presentation = createPresentation({
    state: {
      _records: [record],
      _healthById: new Map(),
      _showProjection: false,
      _coverageMode: 'off',
    },
    services: {},
    parts: {
      selection: { getActiveRecord: () => record },
      geometry: { coverageNeighborCount: () => 0 },
      model: {
        sectorAreaKm2: () => 1.23,
        currentViewContext: () => 'local:2',
        isVideoFeedType: () => false,
      },
      calibration: {
        deriveCalBadge: () => 'raw-prior',
        normalizeCalibration: () => ({}),
      },
      frames: { frameUrlFor: () => '', mediaUrlFor: () => '' },
    },
    source: {},
  });
  const summary = presentation.buildSummaryText();
  assert.match(summary, /MODEL AXIS-Q6135-LE \(DATASET EXACT\)/);
  const state = presentation.getPublicCameraState(record);
  assert.equal(state.modelRef, 'axis-q6135-le');
  assert.equal(state.modelMatch, 'exact');
});
