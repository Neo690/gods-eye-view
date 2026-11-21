import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEVICE_SWEEP_COLOURS,
  DEVICE_SWEEP_LEGEND,
  DEVICE_SWEEP_MISSING_COLOUR,
  deviceAge,
  deviceSweepColour,
  deviceSweepHoverTip,
  deviceSweepItem,
  deviceSweepRow,
} from './presentation.js';
import { orderedSweepDevices } from './source.js';

/** A fixed clock: an age in a test must not depend on when the test ran. */
const NOW = Date.parse('2026-11-20T09:00:00Z');
const DAY = 24 * 3600 * 1000;

const camera = {
  ip: '192.168.1.42',
  mac: '44:19:B6:11:22:33',
  vendor: 'Hikvision',
  hostname: 'nvr-1.lan',
  ports: [{ port: 554, protocol: 'tcp' }],
  verdict: 'camera',
  firstSeen: 2000,
};
const printer = {
  ip: '192.168.1.61',
  mac: '',
  vendor: '',
  hostname: '',
  ports: [{ port: 631, protocol: 'tcp' }],
  verdict: 'network',
  firstSeen: 1000,
};
const lamp = {
  ip: '192.168.1.50',
  mac: 'AA:BB:CC:00:00:01',
  vendor: '',
  hostname: '',
  ports: [],
  verdict: 'unknown',
  firstSeen: 1000,
};

test('an empty sweep says which spaces it is for, and offers no dead chips', () => {
  const row = deviceSweepRow();
  assert.equal(row.count, 0);
  assert.equal(row.added, 0);
  assert.match(row.detail, /your own spaces only/);
  assert.equal(row.clear.disabled, true);
  assert.equal(row.note.disabled, true);
  assert.equal(row.pick.active, false);
  assert.equal(row.pick.label, 'PICK ON GLOBE');
});

test('the row counts devices, flags and what the latest import added', () => {
  const row = deviceSweepRow({
    devices: [camera, printer, lamp],
    place: { lat: 48.85, lon: 2.35 },
    importedAt: 2000,
  });
  assert.equal(row.count, 3);
  assert.equal(row.flagged, 1);
  assert.equal(
    row.added,
    1,
    'only the device first seen in this import is new',
  );
  assert.match(row.summary, /3 devices/);
  assert.match(row.summary, /1 flagged/);
  assert.match(row.summary, /1 new since your last scan/);
  assert.doesNotMatch(row.detail, /Set your place/, 'a place is set');
  assert.equal(row.clear.disabled, false);
  assert.equal(row.note.disabled, false);
});

test('a scan with no place asks for one, and only one way is named', () => {
  const row = deviceSweepRow({ devices: [camera], place: null });
  assert.match(row.detail, /Set your place to draw the scan/);
  assert.match(row.detail, /PICK ON GLOBE/);
});

test('feedback replaces the summary line until the next action', () => {
  const row = deviceSweepRow({
    devices: [camera],
    place: { lat: 1, lon: 2 },
    feedback: 'Imported 1 devices from scan.xml',
  });
  assert.equal(row.detail, 'Imported 1 devices from scan.xml');
});

test('an armed globe click shows itself on the chip', () => {
  const row = deviceSweepRow({ devices: [camera], pickingPlace: true });
  assert.deepEqual(row.pick, { label: 'CANCEL PICK', active: true });
});

test('a marker is coloured by its verdict, and an unknown one is not themed', () => {
  assert.equal(
    deviceSweepColour({ meta: { verdict: 'camera' } }),
    DEVICE_SWEEP_COLOURS.camera,
  );
  assert.equal(deviceSweepColour({ meta: {} }), DEVICE_SWEEP_COLOURS.unknown);
  assert.equal(deviceSweepColour(null), DEVICE_SWEEP_COLOURS.unknown);
});

test('a device the last scan left out is greyed, and says so in its tip', () => {
  assert.equal(
    deviceSweepColour({ meta: { verdict: 'camera', missing: true } }),
    DEVICE_SWEEP_MISSING_COLOUR,
    'absence outranks the verdict colour',
  );
  const text = deviceSweepHoverTip({
    id: 'a',
    label: '192.168.1.42',
    meta: { verdict: 'camera', ports: '554/tcp', missing: true },
  });
  assert.match(text, /Not in your last scan/);
  assert.doesNotMatch(
    deviceSweepHoverTip({ id: 'b', meta: { verdict: 'camera' } }),
    /Not in your last scan/,
  );
});

test('the legend names the grey it draws', () => {
  assert.ok(
    DEVICE_SWEEP_LEGEND.some(
      (entry) => entry.color === DEVICE_SWEEP_MISSING_COLOUR,
    ),
    'a colour on the globe with no legend entry is a mystery',
  );
});

test('the row counts what the latest import no longer sees', () => {
  const row = deviceSweepRow({
    devices: [
      { ...camera, lastSeen: 2000 },
      { ...printer, lastSeen: 1000 },
    ],
    place: { lat: 48.85, lon: 2.35 },
    importedAt: 2000,
  });
  assert.equal(row.missing, 1);
  assert.equal(row.count, 2, 'a quiet device is still counted');
  assert.match(row.summary, /1 not in your last scan/);
});

test('a stored time is spoken as an age, and a fresh one is not spoken at all', () => {
  assert.equal(deviceAge(null, NOW), '');
  assert.equal(deviceAge(0, NOW), '', 'nothing was ever seen');
  assert.equal(
    deviceAge(NOW - 30_000, NOW),
    '',
    'a scan from this minute needs no age',
  );
  assert.equal(deviceAge(NOW - 5 * 60_000, NOW), '5 minutes ago');
  assert.equal(deviceAge(NOW - 2 * 3600_000, NOW), '2 hours ago');
  assert.equal(deviceAge(NOW - DAY, NOW), 'yesterday');
  assert.equal(deviceAge(NOW - 3 * DAY, NOW), '3 days ago');
  assert.equal(deviceAge(NOW - 400 * DAY, NOW), 'last year');
  assert.equal(
    deviceAge(NOW + 5_000, NOW),
    '',
    'a clock running ahead is not an age',
  );
});

test('the row says how long ago the file was read, not when', () => {
  const stale = deviceSweepRow({
    devices: [camera],
    place: { lat: 1, lon: 2 },
    importedAt: NOW - 3 * DAY,
    now: NOW,
  });
  assert.match(stale.summary, /last import 3 days ago/);

  const fresh = deviceSweepRow({
    devices: [camera],
    place: { lat: 1, lon: 2 },
    importedAt: NOW - 5_000,
    now: NOW,
  });
  assert.doesNotMatch(fresh.summary, /last import/);
});

test('a device says when it was last seen, as an age', () => {
  const text = deviceSweepHoverTip(
    {
      id: 'a',
      label: '192.168.1.42',
      meta: { verdict: 'camera', lastSeen: NOW - 3 * DAY },
    },
    { now: NOW },
  );
  assert.match(text, /Last seen: 3 days ago/);
  assert.doesNotMatch(
    deviceSweepHoverTip(
      { id: 'b', meta: { verdict: 'camera', lastSeen: NOW - 1_000 } },
      { now: NOW },
    ),
    /Last seen/,
    'a device seen seconds ago needs no age',
  );
});

test('a row entry names the address, the maker, the verdict, the ports and the age', () => {
  const item = deviceSweepItem(
    { ...camera, lastSeen: NOW - 3 * DAY },
    { importedAt: NOW - 3 * DAY, now: NOW, index: 0 },
  );
  assert.equal(item.lead, '192.168.1.42');
  assert.match(item.text, /Hikvision/);
  assert.match(item.text, /Camera-like/);
  assert.match(item.text, /554\/tcp/);
  assert.match(item.text, /3 days ago/);
  assert.doesNotMatch(item.text, /Not in your last scan/);

  const quiet = deviceSweepItem(
    { ...lamp, lastSeen: NOW - 10 * DAY },
    { importedAt: NOW, now: NOW, index: 7 },
  );
  assert.match(quiet.text, /No open ports/);
  assert.match(quiet.text, /Not in your last scan/);
  assert.equal(deviceSweepItem(null), null);
});


test('the row list follows the ring: flagged first, quiet devices last', () => {
  const ordered = orderedSweepDevices(
    [
      { ...printer, lastSeen: 1000, ip: '192.168.1.61' },
      { ...camera, lastSeen: 2000, ip: '192.168.1.42' },
      { ...lamp, lastSeen: 1000, ip: '10.0.0.9' },
    ],
    2000,
  );
  assert.deepEqual(
    ordered.map((device) => device.ip),
    ['192.168.1.42', '192.168.1.61', '10.0.0.9'],
    'the camera first, then the answered devices, then the quiet ones',
  );
});

test('the hover text shows the evidence, the verdict, the note and newness', () => {
  const text = deviceSweepHoverTip({
    id: 'a',
    label: '192.168.1.42',
    meta: {
      ip: '192.168.1.42',
      hostname: 'nvr-1.lan',
      vendor: 'Hikvision',
      ports: '554/tcp',
      verdict: 'camera',
      reasons: [{ code: 'rtsp', detail: '554/tcp' }],
      note: 'camera above the door',
      newSinceImport: true,
    },
  });
  assert.match(text, /192\.168\.1\.42 · nvr-1\.lan/);
  assert.match(text, /Vendor: Hikvision/);
  assert.match(text, /Open ports: 554\/tcp/);
  assert.match(text, /Verdict: Camera-like/);
  assert.match(text, /RTSP video port/);
  assert.match(text, /New since your last scan/);
  assert.match(text, /Note: camera above the door/);

  const bare = deviceSweepHoverTip({
    id: 'b',
    label: '192.168.1.50',
    meta: { verdict: 'unknown' },
  });
  assert.match(bare, /No open ports in the scan/);
  assert.doesNotMatch(bare, /New since/);
  assert.doesNotMatch(bare, /Note:/);
  assert.equal(deviceSweepHoverTip(null), '');
});
