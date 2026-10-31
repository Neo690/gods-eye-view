import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ALPR_MODELS,
  inspectModels,
  modelPaths,
  modelsDirectory,
  sha256File,
} from './models.js';

test('every model file has a pinned digest and a size', () => {
  for (const [key, model] of Object.entries(ALPR_MODELS)) {
    assert.match(model.sha256, /^[0-9a-f]{64}$/, key);
    assert.ok(model.bytes > 0, key);
    assert.match(model.url, /^https:\/\/github\.com\//, key);
  }
});

test('the digest of a known string is the one a verifier expects', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alpr-models-'));
  const file = path.join(dir, 'abc.txt');
  await fs.writeFile(file, 'abc');
  assert.equal(
    await sha256File(file),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('paths are named after the released files', () => {
  const files = modelPaths('/models');
  assert.equal(
    files.detector,
    path.join('/models', 'yolo-v9-t-384-license-plates-end2end.onnx'),
  );
  assert.equal(files.ocr, path.join('/models', 'cct_xs_v2_global.onnx'));
  assert.equal(
    files.ocrConfig,
    path.join('/models', 'cct_xs_v2_global_plate_config.yaml'),
  );
});

test('the directory follows the environment, and is absolute', () => {
  const relative = modelsDirectory({ GEV_ALPR_MODELS_DIR: 'weights/alpr' });
  assert.ok(path.isAbsolute(relative));
  assert.ok(relative.endsWith(path.join('weights', 'alpr')));
  const fallback = modelsDirectory({});
  assert.ok(fallback.endsWith(path.join('.gev-cache', 'alpr', 'v1')));
});

test('an empty directory reports every file as missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alpr-empty-'));
  const report = await inspectModels(dir);
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing.sort(), Object.keys(ALPR_MODELS).sort());
  assert.deepEqual(report.mismatched, []);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a file that is not the pinned bytes is reported as mismatched', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'alpr-wrong-'));
  for (const model of Object.values(ALPR_MODELS))
    await fs.writeFile(path.join(dir, model.file), 'not the model');
  const report = await inspectModels(dir);
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, []);
  assert.equal(report.mismatched.length, Object.keys(ALPR_MODELS).length);
  await fs.rm(dir, { recursive: true, force: true });
});
