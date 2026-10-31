import assert from 'node:assert/strict';
import test from 'node:test';

import { looksLikePlate, threadsForCgroupQuota } from './engine.js';

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

test('a caption longer than any registration is not a plate', () => {
  // A tile read a green street sign — "Colorado / 300 ST 200" — as this.
  assert.equal(looksLikePlate('COI0T0Q00T'), false);
  assert.equal(looksLikePlate('COLORADO ST 3RD'), false);
});

test('a registration of the longest shapes still passes', () => {
  assert.equal(looksLikePlate('AB-123-CD'), true);
  assert.equal(looksLikePlate('12-ABC-3'), true);
  assert.equal(looksLikePlate('1-ABC-123'), true);
  assert.equal(looksLikePlate('5AU5341'), true);
});

test('a fragment shorter than any registration is not a plate', () => {
  // What a tile read of a plate cut by a seam used to produce.
  assert.equal(looksLikePlate('13C'), false);
  assert.equal(looksLikePlate('A1'), false);
});

test('text that is not text is not a plate', () => {
  assert.equal(looksLikePlate(''), false);
  assert.equal(looksLikePlate(null), false);
  assert.equal(looksLikePlate(undefined), false);
});

test('a container gets the threads its quota allows, not the host count', () => {
  // Render's free instance: a tenth of a core. Flooring to zero threads is not
  // an option, and a pool sized from `os.cpus()` would oversubscribe it.
  assert.equal(threadsForCgroupQuota('10000 100000'), 1);
  assert.equal(threadsForCgroupQuota('5000 100000'), 1);
  assert.equal(threadsForCgroupQuota('200000 100000'), 2);
  assert.equal(threadsForCgroupQuota('400000 100000'), 4);
  // No quota, or an unlimited one: the runtime's own pool is the right choice.
  assert.equal(threadsForCgroupQuota('max 100000'), null);
  assert.equal(threadsForCgroupQuota('-1'), null);
  assert.equal(threadsForCgroupQuota(''), null);
  assert.equal(threadsForCgroupQuota(undefined), null);
  assert.equal(threadsForCgroupQuota('garbage'), null);
  // cgroup v1 states the pair in two files.
  assert.equal(threadsForCgroupQuota('50000', 100000), 1);
  assert.equal(threadsForCgroupQuota('-1', 100000), null);
});
