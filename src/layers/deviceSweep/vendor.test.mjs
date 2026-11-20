import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVICE_VENDOR_PREFIXES, vendorForMac } from './scan.js';

// The shortlist exists to name a maker with certainty, so it is small on
// purpose. These checks are its review gate: a prefix added here is a claim
// that the IEEE MA-L registry assigns it to the maker of an appliance, and a
// new maker has to be a deliberate decision rather than a passing edit.
// `node scripts/check-device-vendors.mjs` re-reads the live registries.

const MA_L_PREFIX = /^[0-9a-f]{6}$/;

test('every prefix is a lowercase MA-L block naming a maker', () => {
  const entries = Object.entries(DEVICE_VENDOR_PREFIXES);
  assert.ok(entries.length > 0);
  for (const [prefix, vendor] of entries) {
    assert.match(prefix, MA_L_PREFIX, `${prefix} must be six lowercase hex`);
    assert.ok(vendor.trim(), `${prefix} must name its maker`);
    assert.equal(
      vendorForMac(
        `${prefix.slice(0, 2)}:${prefix.slice(2, 4)}:${prefix.slice(4)}:00:00:01`,
      ),
      vendor,
      `${prefix} must resolve through a real MAC`,
    );
  }
  assert.ok(
    Object.isFrozen(DEVICE_VENDOR_PREFIXES),
    'the shortlist is a constant, not a place to push entries at runtime',
  );
});

test('the shortlist holds appliance makers only, and says which', () => {
  assert.deepEqual(
    [...new Set(Object.values(DEVICE_VENDOR_PREFIXES))].sort(),
    ['Axis', 'Dahua', 'Hikvision', 'Raspberry Pi'],
    'a new maker here is a review decision, not an edit',
  );
});

test('a module maker is never named as the maker of a device', () => {
  // Espressif and Tuya own their blocks, but the block covers the radio
  // module inside a lamp, a plug and a camera alike.
  for (const mac of ['24:0A:C4:00:00:01', '10:D5:61:00:00:01'])
    assert.equal(vendorForMac(mac), '');
});
