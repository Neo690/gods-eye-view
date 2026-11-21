import assert from 'node:assert/strict';
import test from 'node:test';

import { IMPORT_OVERLAP_FLOOR, importOverlap, importScanFile } from './importScan.js';
import { SCAN_MAX_DEVICES, parseInventory } from './scan.js';

/** The File the picker hands over: a name and its text, read once. */
const file = (name, text) => ({ name, text: async () => text });

/** A store that records what was written, and what it already holds. */
function fakeStore(added, known = []) {
  const writes = [];
  return {
    writes,
    read: () => ({ devices: known }),
    write(payload) {
      writes.push(payload);
      return { added };
    },
  };
}

const LEASES = [
  '192.168.1.10,aa:bb:cc:dd:ee:01,laptop',
  '192.168.1.11,aa:bb:cc:dd:ee:02,phone',
  '192.168.1.12,aa:bb:cc:dd:ee:03,cam-entree',
  '192.168.1.14,aa:bb:cc:dd:ee:04,ancienne-cam',
];
const THREE_LEASES = LEASES.slice(0, 3).join('\n');

/** Another operator's network: no device in it is one of the three above. */
const OTHER_NETWORK = [
  '10.0.0.20,00:11:22:33:44:01,desktop',
  '10.0.0.21,00:11:22:33:44:02,printer',
].join('\n');

/**
 * The sweep already stored: all four leases, so the quiet camera is kept and
 * grey. Built through the parser so the keys under test are the store's own.
 */
const KNOWN = parseInventory(LEASES.join('\n')).devices;

test('an import says what it read, and how much of it is new', async () => {
  const store = fakeStore(2);
  const { line, pending } = await importScanFile({
    file: file('wifi.txt', THREE_LEASES),
    store,
  });
  assert.equal(
    line,
    'Imported 3 devices from wifi.txt · 2 new since your last scan',
  );
  assert.equal(pending, undefined, 'a first import has nothing to contradict');
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
  const { line } = await importScanFile({
    file: file('big.txt', rows.join('\n')),
    store,
  });
  assert.equal(store.writes[0].devices.length, SCAN_MAX_DEVICES);
  assert.match(line, /^Imported 256 devices from big\.txt/);
  assert.match(
    line,
    / · capped at 256$/,
    'the row says the file held more than the layer keeps',
  );
});

test('a file that is not an inventory is refused, and nothing is stored', async () => {
  const store = fakeStore(0);
  const { line, pending } = await importScanFile({
    file: file('notes.txt', 'name,colour\nfoo,red\n'),
    store,
  });
  assert.equal(line, 'That file is not an inventory this layer reads');
  assert.equal(pending, undefined);
  assert.deepEqual(store.writes, []);
});

test('a file that names almost none of the sweep is not written, it is asked about', async () => {
  const store = fakeStore(2, KNOWN);
  const picked = file('office.txt', OTHER_NETWORK);
  const { line, pending } = await importScanFile({ file: picked, store });

  assert.deepEqual(
    store.writes,
    [],
    'another network is never added behind the operator',
  );
  assert.equal(pending.file, picked, 'the held file comes back for the answer');
  assert.equal(pending.matched, 0);
  assert.equal(pending.total, 4);
  assert.equal(
    line,
    'Only 0 of your 4 devices are in this file. Import it anyway? Your scan would stay, greyed, and this one would be added to it.',
  );
});

test('answering the question writes the file it was holding', async () => {
  const store = fakeStore(2, KNOWN);
  const picked = file('office.txt', OTHER_NETWORK);
  await importScanFile({ file: picked, store });

  const { line, pending } = await importScanFile({
    file: picked,
    store,
    confirm: true,
  });
  assert.equal(pending, undefined);
  assert.equal(store.writes.length, 1, 'the confirmed file is stored once');
  assert.equal(store.writes[0].name, 'office.txt');
  assert.match(line, /^Imported 2 devices from office\.txt/);
});

test('a re-scan of the same network is imported without asking', async () => {
  // Three of the four stored devices are in the file: a re-scan, not a stranger.
  const store = fakeStore(3, KNOWN);
  const { line, pending } = await importScanFile({
    file: file('wifi.txt', THREE_LEASES),
    store,
  });

  assert.equal(pending, undefined);
  assert.equal(store.writes.length, 1);
  assert.match(line, /^Imported 3 devices from wifi\.txt/);
});

test('the overlap is a share of what is stored, and nothing is unfamiliar at first', () => {
  assert.deepEqual(importOverlap(), {
    known: 0,
    matched: 0,
    unfamiliar: false,
  });
  const [first] = parseInventory(THREE_LEASES).devices;
  // One device out of four is a quarter of the sweep: recognisable, imported.
  assert.deepEqual(importOverlap({ known: KNOWN, incoming: [first] }), {
    known: 4,
    matched: 1,
    unfamiliar: false,
  });
  // One out of eight is not: that file belongs to somebody else's network.
  const wide = parseInventory(
    Array.from(
      { length: 8 },
      (_, index) => `192.168.1.${20 + index},aa:bb:cc:dd:0${index}:01,host${index}`,
    ).join('\n'),
  ).devices;
  assert.deepEqual(importOverlap({ known: wide, incoming: [wide[0]] }), {
    known: 8,
    matched: 1,
    unfamiliar: true,
  });
  assert.equal(
    IMPORT_OVERLAP_FLOOR,
    0.25,
    'a quarter of the sweep is the line between a re-scan and a stranger',
  );
});
