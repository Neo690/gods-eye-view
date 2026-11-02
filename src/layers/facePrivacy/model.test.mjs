import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FACE_LAYER_ID,
  confidencePercent,
  faceCount,
  formatFace,
  isCachedAnswer,
  isFacePayload,
} from './model.js';

test('the layer id is stable across panel, state and source', () => {
  assert.equal(FACE_LAYER_ID, 'face-privacy');
});

test('a detector score becomes a whole percentage, clamped', () => {
  assert.equal(confidencePercent(0.971), 97);
  assert.equal(confidencePercent(0), 0);
  assert.equal(confidencePercent(1.4), 100);
  assert.equal(confidencePercent(-1), 0);
  assert.equal(confidencePercent(undefined), null);
  assert.equal(confidencePercent('curious'), null);
});

test('a face is shown as its confidence only, never a name', () => {
  assert.equal(formatFace({ score: 0.9 }), '90%');
  assert.equal(formatFace({}), null);
});

test('a payload without a faces array is not the shape this layer renders', () => {
  assert.equal(isFacePayload({ faces: [] }), true);
  assert.equal(isFacePayload({}), false);
  assert.equal(isFacePayload(null), false);
  assert.equal(isFacePayload({ plates: [] }), false);
});

test('a count comes from the faces the response carried', () => {
  assert.equal(faceCount({ faces: [{}, {}] }), 2);
  assert.equal(faceCount({ faces: [] }), 0);
  assert.equal(faceCount(null), 0);
  assert.equal(faceCount({ plates: [{}] }), 0);
});

test('a cached answer is named as such and uncached is not', () => {
  assert.equal(isCachedAnswer({ cached: true }), true);
  assert.equal(isCachedAnswer({ cached: false }), false);
  assert.equal(isCachedAnswer({}), false);
});
