import assert from 'node:assert/strict';
import test from 'node:test';

import { createFaceLayer } from './index.js';

/** A CCTV stand-in that reports whatever camera the test selects. */
function cctv(selectedCameraId = null) {
  return { getParams: () => ({ selectedCameraId }) };
}

/** A source that answers with one face and counts how often it was asked. */
function source(faces = [{ score: 0.97, box: {} }]) {
  const calls = [];
  return {
    calls,
    read: async (cameraId) => {
      calls.push(cameraId);
      return { camera: { id: cameraId }, faces, cached: false };
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a face layer without a read source is refused at construction', () => {
  assert.throws(() => createFaceLayer({ camera: cctv() }), /read source/);
});

test('nothing can be analysed until the layer is on', async () => {
  const reader = source();
  const layer = createFaceLayer({ source: reader, camera: cctv('cam-1') });
  layer.init({});
  assert.equal(layer.getRowControls().chips[0].disabled, true);
  layer.enable();
  assert.equal(layer.getRowControls().chips[0].disabled, false);
  layer.disable();
  assert.equal(layer.getRowControls().chips[0].disabled, true);
});

test('the row asks for a camera before offering an analysis', () => {
  const layer = createFaceLayer({ source: source(), camera: cctv(null) });
  layer.init({});
  layer.enable();
  const controls = layer.getRowControls();
  assert.equal(controls.chips[0].disabled, true);
  assert.match(controls.info, /Select a CCTV camera first/);
});

test('an analysis shows the face count of the selected camera', async () => {
  const reader = source([{ score: 0.97 }, { score: 0.51 }]);
  const layer = createFaceLayer({
    source: reader,
    camera: cctv('cam-1'),
    now: () => 1234,
    overlay: overlaySpy(),
  });
  layer.init({});
  layer.enable();
  layer.getRowControls().chips[0].onClick();
  await settle();
  assert.deepEqual(reader.calls, ['cam-1']);
  assert.match(layer.getRowControls().info, /2 faces visible/);
  assert.deepEqual(layer.getStats(), {
    faces: 2,
    cameraId: 'cam-1',
    lastReadAt: 1234,
    busy: false,
    blurring: true,
    error: null,
  });
});

test('turning the chip off removes the blur without another read', async () => {
  const reader = source();
  const blur = overlaySpy();
  const layer = createFaceLayer({
    source: reader,
    camera: cctv('cam-1'),
    overlay: blur,
  });
  layer.init({});
  layer.enable();
  layer.getRowControls().chips[0].onClick();
  await settle();
  layer.getRowControls().chips[0].onClick();
  await settle();
  assert.deepEqual(reader.calls, ['cam-1']);
  assert.equal(layer.getStats().blurring, false);
  assert.equal(blur.clears, 1);
  assert.match(layer.getRowControls().info, /1 face visible/);
});

test('an empty analysis says so instead of leaving a stale blur points at nobody', async () => {
  const blur = overlaySpy();
  const layer = createFaceLayer({
    source: source([]),
    camera: cctv('cam-1'),
    overlay: blur,
  });
  layer.init({});
  layer.enable();
  layer.getRowControls().chips[0].onClick();
  await settle();
  assert.match(layer.getRowControls().info, /No face found/);
});

test('two clicks while the first analysis runs share one request', async () => {
  let release = null;
  const calls = [];
  const layer = createFaceLayer({
    source: {
      read: (cameraId) => {
        calls.push(cameraId);
        return new Promise((resolve) => {
          release = () => resolve({ faces: [] });
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

test('the row is busy while an analysis runs', async () => {
  let release = null;
  const layer = createFaceLayer({
    source: {
      read: () =>
        new Promise((resolve) => {
          release = () => resolve({ faces: [] });
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

test('a refusal is reported without claiming a face', async () => {
  const layer = createFaceLayer({
    source: {
      read: async () => {
        const error = new Error('The face engine cannot run here');
        error.code = 'runtime_missing';
        error.detail = 'onnxruntime-node and sharp are required';
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
  assert.match(controls.info, /Face analysis unavailable/);
  assert.match(controls.infoTitle, /onnxruntime-node/);
  assert.equal(layer.getStats().faces, 0);
});

test('a result belongs to the camera it was analysed from', async () => {
  let selected = 'cam-1';
  const layer = createFaceLayer({
    source: source(),
    camera: { getParams: () => ({ selectedCameraId: selected }) },
  });
  layer.init({});
  layer.enable();
  layer.getRowControls().chips[0].onClick();
  await settle();
  assert.match(layer.getRowControls().info, /1 face visible/);
  selected = 'cam-2';
  assert.match(layer.getRowControls().info, /Nothing analysed yet/);
});

test('a camera change takes the blur off the picture', async () => {
  const blur = overlaySpy();
  let selected = 'cam-1';
  const camera = {
    getParams: () => ({ selectedCameraId: selected }),
    subscribe: (listener) => {
      camera.notify = listener;
      return () => {
        camera.notify = null;
      };
    },
  };
  const layer = createFaceLayer({ source: source(), camera, overlay: blur });
  layer.init({});
  layer.enable();
  layer.getRowControls().chips[0].onClick();
  await settle();
  assert.equal(layer.getStats().blurring, true);
  selected = 'cam-2';
  camera.notify({ activeCameraId: 'cam-2' });
  assert.equal(layer.getStats().blurring, false);
  assert.equal(blur.clears, 1);
});

test('turning the layer off forgets the answer and the blur', async () => {
  const blur = overlaySpy();
  const layer = createFaceLayer({
    source: source(),
    camera: cctv('cam-1'),
    overlay: blur,
  });
  layer.init({});
  layer.enable();
  layer.getRowControls().chips[0].onClick();
  await settle();
  layer.disable();
  assert.equal(layer.getStats().faces, 0);
  assert.equal(layer.getStats().blurring, false);
  layer.enable();
  assert.match(layer.getRowControls().info, /Nothing analysed yet/);
});

test('the layer survives the manager tick that has nothing to fetch', async () => {
  const layer = createFaceLayer({ source: source(), camera: cctv('cam-1') });
  layer.init({});
  layer.enable();
  assert.equal(typeof layer.update, 'function');
  assert.equal(await layer.update(), true);
});

test('the layer reports no analysable records', () => {
  const layer = createFaceLayer({ source: source(), camera: cctv() });
  assert.deepEqual(layer.getAnalystRecords(), []);
});

/** One overlay stand-in counting draws and clears. */
function overlaySpy() {
  return {
    draws: [],
    clears: 0,
    show(next) {
      if (next && Array.isArray(next.faces) && next.faces.length) {
        this.draws.push(next);
        this.clears = 0;
      } else this.clears += 1;
    },
    clear() {
      this.clears += 1;
    },
    destroy() {},
  };
}
