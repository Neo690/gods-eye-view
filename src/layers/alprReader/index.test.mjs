import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlateReaderLayer } from './index.js';

/** A CCTV stand-in that reports whatever camera the test selects. */
function cctv(selectedCameraId = null) {
  return { getParams: () => ({ selectedCameraId }) };
}

/** A source that answers with one plate and counts how often it was asked. */
function source(plates = [{ text: 'AB-123-CD', confidence: 0.98 }]) {
  const calls = [];
  return {
    calls,
    read: async (cameraId) => {
      calls.push(cameraId);
      return { camera: { id: cameraId }, plates, cached: false };
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a layer without a read source is refused at construction', () => {
  assert.throws(() => createPlateReaderLayer({ camera: cctv() }), /read source/);
});

test('nothing can be read until the layer is on', async () => {
  const reader = source();
  const layer = createPlateReaderLayer({ source: reader, camera: cctv('cam-1') });
  layer.init({});
  assert.equal(layer.getRowControls().chips[0].disabled, true);
  layer.enable();
  assert.equal(layer.getRowControls().chips[0].disabled, false);
  layer.disable();
  assert.equal(layer.getRowControls().chips[0].disabled, true);
});

test('the row asks for a camera before offering a read', () => {
  const layer = createPlateReaderLayer({ source: source(), camera: cctv(null) });
  layer.init({});
  layer.enable();
  const controls = layer.getRowControls();
  assert.equal(controls.chips[0].disabled, true);
  assert.match(controls.info, /Select a CCTV camera first/);
});

test('a read shows the plates of the selected camera', async () => {
  const reader = source();
  const layer = createPlateReaderLayer({
    source: reader,
    camera: cctv('cam-1'),
    now: () => 1234,
  });
  layer.init({});
  layer.enable();
  layer.getRowControls().chips[0].onClick();
  await settle();
  assert.deepEqual(reader.calls, ['cam-1']);
  assert.equal(layer.getRowControls().info, 'AB-123-CD · 98%');
  assert.deepEqual(layer.getStats(), {
    plates: 1,
    cameraId: 'cam-1',
    lastReadAt: 1234,
    busy: false,
    error: null,
  });
});

test('an empty answer says so instead of showing nothing', async () => {
  const layer = createPlateReaderLayer({
    source: source([]),
    camera: cctv('cam-1'),
  });
  layer.init({});
  layer.enable();
  layer.getRowControls().chips[0].onClick();
  await settle();
  assert.match(layer.getRowControls().info, /No plate found/);
});

test('two clicks while the first read is running share one request', async () => {
  let release = null;
  const calls = [];
  const layer = createPlateReaderLayer({
    source: {
      read: (cameraId) => {
        calls.push(cameraId);
        return new Promise((resolve) => {
          release = () => resolve({ plates: [] });
        });
      },
    },
    camera: cctv('cam-1'),
  });
  layer.init({});
  layer.enable();
  const chip = layer.getRowControls().chips[0];
  chip.onClick();
  chip.onClick();
  await settle();
  assert.deepEqual(calls, ['cam-1']);
  release();
  await settle();
});

test('the row is busy while a read runs', async () => {
  let release = null;
  const layer = createPlateReaderLayer({
    source: {
      read: () =>
        new Promise((resolve) => {
          release = () => resolve({ plates: [] });
        }),
    },
    camera: cctv('cam-1'),
  });
  layer.init({});
  layer.enable();
  layer.getRowControls().chips[0].onClick();
  await settle();
  assert.match(layer.getRowControls().info, /Reading the selected camera/);
  assert.equal(layer.getRowControls().chips[0].disabled, true);
  release();
  await settle();
});

test('a refusal is reported without inventing a plate', async () => {
  const layer = createPlateReaderLayer({
    source: {
      read: async () => {
        const error = new Error('The plate reader models are not installed');
        error.code = 'models_missing';
        error.detail = 'npm run alpr:models';
        throw error;
      },
    },
    camera: cctv('cam-1'),
  });
  layer.init({});
  layer.enable();
  layer.getRowControls().chips[0].onClick();
  await settle();
  const controls = layer.getRowControls();
  assert.match(controls.info, /Plate reader unavailable/);
  assert.match(controls.infoTitle, /alpr:models/);
  assert.equal(layer.getStats().plates, 0);
});

test('a result belongs to the camera it was read from', async () => {
  let selected = 'cam-1';
  const layer = createPlateReaderLayer({
    source: source(),
    camera: { getParams: () => ({ selectedCameraId: selected }) },
  });
  layer.init({});
  layer.enable();
  layer.getRowControls().chips[0].onClick();
  await settle();
  assert.match(layer.getRowControls().info, /AB-123-CD/);
  selected = 'cam-2';
  assert.match(layer.getRowControls().info, /Nothing read yet/);
});

test('turning the layer off forgets the answer', async () => {
  const layer = createPlateReaderLayer({
    source: source(),
    camera: cctv('cam-1'),
  });
  layer.init({});
  layer.enable();
  layer.getRowControls().chips[0].onClick();
  await settle();
  layer.disable();
  assert.equal(layer.getStats().plates, 0);
  layer.enable();
  assert.match(layer.getRowControls().info, /Nothing read yet/);
});

test('the reader reports no analysable records', () => {
  const layer = createPlateReaderLayer({ source: source(), camera: cctv() });
  assert.deepEqual(layer.getAnalystRecords(), []);
});
