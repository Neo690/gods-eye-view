import assert from 'node:assert/strict';
import test from 'node:test';

import { importScanFile } from './importScan.js';
import { SCAN_MAX_DEVICES } from './scan.js';

/** The File the picker hands over: a name and its text, read once. */
const file = (name, text) => ({ name, text: async () => text });

/** A store that records what was written and answers with the new count. */
function fakeStore(added) {
  const writes = [];
  return {
    writes,
    write(payload) {
      writes.push(payload);
      return { added };
    },
  };
}

const THREE_LEASES = [
  '192.168.1.10,aa:bb:cc:dd:ee:01,laptop',
  '192.168.1.11,aa:bb:cc:dd:ee:02,phone',
  '192.168.1.12,aa:bb:cc:dd:ee:03,cam-entree',
].join('\n');

test('an import says what it read, and how much of it is new', async () => {
  const store = fakeStore(2);
  const feedback = await importScanFile({
    file: file('wifi.txt', THREE_LEASES),
    store,
  });
  assert.equal(
    feedback,
    'Imported 3 devices from wifi.txt · 2 new since your last scan',
  );
  assert.equal(store.writes.length, 1, 'the file was read once and stored');
  assert.equal(store.writes[0].devices.length, 3);
  assert.equal(store.writes[0].name, 'wifi.txt');
});

test('a scan past the cap says so, beside what was new', async () => {
  const rows = Array.from({ length: SCAN_MAX_DEVICES + 5 }, (_, index) => {
    const ip = `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`;
    const mac = [0xaa, 0xbb, index >> 8, index & 0xff, 0x01, 0x02]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(':');
    return `${ip},${mac}`;
  });
  const store = fakeStore(SCAN_MAX_DEVICES + 5);
  const feedback = await importScanFile({
    file: file('big.txt', rows.join('\n')),
    store,
  });
  assert.equal(store.writes[0].devices.length, SCAN_MAX_DEVICES);
  assert.match(feedback, /^Imported 256 devices from big\.txt/);
  assert.match(
    feedback,
    / · capped at 256$/,
    'the row says the file held more than the layer keeps',
  );
});

test('a file that is not an inventory is refused, and nothing is stored', async () => {
  const store = fakeStore(0);
  const feedback = await importScanFile({
    file: file('notes.txt', 'name,colour\nfoo,red\n'),
    store,
  });
  assert.equal(feedback, 'That file is not an inventory this layer reads');
  assert.deepEqual(store.writes, []);
});
