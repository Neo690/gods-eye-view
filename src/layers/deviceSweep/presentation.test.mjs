import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEVICE_SWEEP_COLOURS,
  deviceSweepColour,
  deviceSweepHoverTip,
  deviceSweepRow,
} from './presentation.js';

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
