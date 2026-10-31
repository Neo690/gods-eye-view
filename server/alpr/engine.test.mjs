import assert from 'node:assert/strict';
import test from 'node:test';

import { looksLikePlate } from './engine.js';

test('a registration carries letters and digits, so it is kept', () => {
  assert.equal(looksLikePlate('AB-123-CD'), true);
  assert.equal(looksLikePlate('5AU5341'), true);
  assert.equal(looksLikePlate('AB1234'), true);
});

test('a camera overlay that happens to look like a plate is dropped', () => {
  // Observed on real cameras: an operator logo at 0.99, and a timestamp.
  assert.equal(looksLikePlate('WSDOT'), false);
  assert.equal(looksLikePlate('CALTRANS'), false);
  assert.equal(looksLikePlate('010526'), false);
});

test('text that is not text is not a plate', () => {
  assert.equal(looksLikePlate(''), false);
  assert.equal(looksLikePlate(null), false);
  assert.equal(looksLikePlate(undefined), false);
});
