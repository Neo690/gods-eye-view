import assert from 'node:assert/strict';
import test from 'node:test';

import {
  confidencePercent,
  formatPlate,
  isCachedAnswer,
  isPlatePayload,
  plateLines,
} from './model.js';

test('a confidence is shown as a rounded percentage', () => {
  assert.equal(confidencePercent(0.9876), 99);
  assert.equal(confidencePercent(1), 100);
  assert.equal(confidencePercent(0), 0);
  assert.equal(confidencePercent('nonsense'), null);
});

test('a confidence outside 0..1 is clamped, not printed as-is', () => {
  assert.equal(confidencePercent(1.4), 100);
  assert.equal(confidencePercent(-0.2), 0);
});

test('a plate is its text, then how sure the OCR was', () => {
  assert.equal(formatPlate({ text: 'AB-123-CD', confidence: 0.98 }), 'AB-123-CD · 98%');
});

test('a plate without a usable confidence is still shown', () => {
  assert.equal(formatPlate({ text: 'AB-123-CD' }), 'AB-123-CD');
  assert.equal(formatPlate({ text: '  AB-123-CD  ' }), 'AB-123-CD');
});

test('something that is not a plate is not formatted into one', () => {
  assert.equal(formatPlate({ text: '' }), null);
  assert.equal(formatPlate(null), null);
});

test('the plates of an answer keep their order and drop empty ones', () => {
  const payload = {
    plates: [
      { text: 'AA-111-AA', confidence: 0.9 },
      { text: '', confidence: 0.4 },
      { text: 'BB-222-BB', confidence: 0.8 },
    ],
  };
  assert.deepEqual(plateLines(payload), ['AA-111-AA · 90%', 'BB-222-BB · 80%']);
});

test('a payload without a plate array is not an answer', () => {
  assert.equal(isPlatePayload(null), false);
  assert.equal(isPlatePayload({ error: 'models_missing' }), false);
  assert.deepEqual(plateLines({ error: 'models_missing' }), []);
});

test('a cached answer says so', () => {
  assert.equal(isCachedAnswer({ plates: [], cached: true }), true);
  assert.equal(isCachedAnswer({ plates: [] }), false);
});
