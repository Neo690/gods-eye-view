import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyDevice, parseInventory, vendorForMac } from './scan.js';
import {
  DEVICE_SWEEP_STORAGE_KEY,
  DeviceSweepStoreError,
  createDeviceSweepStore,
} from './store.js';
import {
  createDeviceSweepSource,
  devicesInBounds,
  sweepPointFor,
} from './source.js';

/** The shape `nmap -sn` prints. */
const NORMAL_SWEEP = [
  'Starting Nmap 7.95 ( https://nmap.org ) at 2026-11-19 21:04 CET',
  'Nmap scan report for router.lan (192.168.1.1)',
  'Host is up (0.0040s latency).',
  'Nmap scan report for 192.168.1.42',
  'Host is up (0.012s latency).',
  'MAC Address: 44:19:B6:11:22:33 (Hikvision)',
  '554/tcp   open  rtsp',
  '80/tcp    open  http',
  '8000/tcp  open  http-alt',
  'Nmap scan report for 192.168.1.50',
  'Host is up (0.0080s latency).',
  'MAC Address: 24:0A:C4:AA:BB:CC (Espressif)',
  'Nmap done: 256 IP addresses (3 hosts up) scanned in 4.21 seconds',
  '',
].join('\n');

/** The shape `nmap -oX` writes. */
const XML_SCAN = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<nmaprun scanner="nmap" args="nmap -sV 192.168.1.0/24">',
  '<host><status state="up"/><address addr="192.168.1.60" addrtype="ipv4"/>',
  '<address addr="3C:EF:8C:01:02:03" addrtype="mac" vendor="Dahua"/>',
  '<hostnames><hostname name="nvr-1.lan" type="PTR"/></hostnames>',
  '<ports><port protocol="tcp" portid="37777"><state state="open"/>',
  '<service name="dahua" product="Dahua NVR"/></port>',
  '<port protocol="tcp" portid="443"><state state="closed"/></port></ports></host>',
  '<host><status state="up"/><address addr="192.168.1.61" addrtype="ipv4"/>',
  '<ports><port protocol="tcp" portid="631"><state state="open"/>',
  '<service name="ipp"/></port></ports></host>',
  '<host><status state="down"/><address addr="192.168.1.99" addrtype="ipv4"/></host>',
  '</nmaprun>',
  '',
].join('\n');

/** The shape `nmap -oG` writes. */
const GREPPABLE_SCAN = [
  '# Nmap 7.95 scan initiated Wed Nov 19 21:04:06 2026',
  'Host: 192.168.1.70 (cam.local)\tStatus: Up',
  'Host: 192.168.1.70 (cam.local)\tPorts: 554/open/tcp//rtsp//Hikvision/, 80/open/tcp//http///',
  'Host: 192.168.1.71\tPorts: 22/open/tcp//ssh///',
  '# Nmap done at Wed Nov 19 21:04:31 2026',
  '',
].join('\n');

/** The shape `arp -a` prints on Linux and macOS. */
const ARP_TABLE = [
  '? (192.168.1.1) at 00:11:22:33:44:55 [ether] on eth0',
  '? (192.168.1.42) at 44:19:b6:11:22:33 [ether] on eth0',
  '? (192.168.1.77) at <incomplete> on eth0',
  '',
].join('\n');

/** The shape `/proc/net/arp` holds. */
const PROC_ARP = [
  'IP address       HW type     Flags       HW address            Mask     Device',
  '192.168.1.1      0x1         0x2         00:11:22:33:44:55     *        eth0',
  '192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        eth0',
  '192.168.1.42     0x1         0x2         b8:27:eb:00:00:01     *        eth0',
  '',
].join('\n');

/** The shape a router's DHCP lease export takes: address, MAC, name, time. */
const LEASES = [
  '192.168.1.10,aa:bb:cc:dd:ee:ff,laptop-living-room,2026-11-21 09:12:00',
  '192.168.1.11   44-19-B6-11-22-33   dynamic',
  '# end of the lease list',
  '',
].join('\n');

test('a normal nmap report becomes devices with their MAC, vendor and ports', () => {
  const result = parseInventory(NORMAL_SWEEP);
  assert.equal(result.format, 'normal');
  assert.equal(result.devices.length, 3);
  const camera = result.devices.find((device) => device.ip === '192.168.1.42');
  assert.equal(camera.mac, '44:19:B6:11:22:33');
  assert.equal(camera.vendor, 'Hikvision');
  assert.deepEqual(
    camera.ports.map((port) => port.port),
    [80, 554, 8000],
  );
  assert.equal(camera.verdict, 'camera');
  assert.equal(
    result.devices.find((device) => device.ip === '192.168.1.1').hostname,
    'router.lan',
  );
});

test('the XML report keeps open ports, drops closed ones and skips down hosts', () => {
  const result = parseInventory(XML_SCAN);
  assert.equal(result.format, 'xml');
  assert.deepEqual(
    result.devices.map((device) => device.ip),
    ['192.168.1.60', '192.168.1.61'],
  );
  const nvr = result.devices[0];
  assert.equal(nvr.vendor, 'Dahua');
  assert.equal(nvr.hostname, 'nvr-1.lan');
  assert.deepEqual(
    nvr.ports.map((port) => port.port),
    [37777],
    'a closed port is not evidence',
  );
  assert.equal(nvr.verdict, 'camera');
  const printer = result.devices[1];
  assert.equal(printer.verdict, 'network', 'one admin port is not a camera');
});

test('the greppable report is read the same way', () => {
  const result = parseInventory(GREPPABLE_SCAN);
  assert.equal(result.format, 'greppable');
  const camera = result.devices.find((device) => device.ip === '192.168.1.70');
  assert.equal(camera.hostname, 'cam.local');
  assert.deepEqual(
    camera.ports.map((port) => port.port),
    [80, 554],
    'ports are listed in numeric order, not file order',
  );
  assert.equal(camera.verdict, 'camera');
  assert.equal(
    result.devices.find((device) => device.ip === '192.168.1.71').verdict,
    'network',
    'an SSH-only host is a network device, not a camera',
  );
});

test('an ARP table is an inventory: addresses, MACs and the names arp knew', () => {
  const result = parseInventory(ARP_TABLE);
  assert.equal(result.format, 'arp');
  assert.deepEqual(
    result.devices.map((device) => device.ip),
    ['192.168.1.1', '192.168.1.42'],
    'the entry that never learned a MAC is skipped',
  );
  assert.equal(result.devices[0].mac, '00:11:22:33:44:55');
  const camera = result.devices[1];
  assert.equal(
    camera.mac,
    '44:19:B6:11:22:33',
    'a lower-case MAC is normalised',
  );
  assert.equal(camera.vendor, 'Hikvision');
  assert.equal(camera.verdict, 'camera', 'the MAC is enough to flag it');
});

test('/proc/net/arp is read from its columns, without a zero MAC', () => {
  const result = parseInventory(PROC_ARP);
  assert.equal(result.format, 'arp');
  assert.deepEqual(
    result.devices.map((device) => device.ip),
    ['192.168.1.1', '192.168.1.42'],
  );
  assert.equal(result.devices[1].vendor, 'Raspberry Pi');
});

test('a lease list keeps the address, the MAC and the name it carries', () => {
  const result = parseInventory(LEASES);
  assert.equal(result.format, 'leases');
  assert.equal(result.devices.length, 2);
  const laptop = result.devices[0];
  assert.equal(laptop.mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(laptop.hostname, 'laptop-living-room');
  const camera = result.devices[1];
  assert.equal(camera.mac, '44:19:B6:11:22:33', 'a dashed MAC is read too');
  assert.equal(camera.hostname, '', 'a lease state is not a host name');
  assert.equal(camera.verdict, 'camera');
});

/**
 * A French and an Italian export write the lease state where a host name would
 * go. French is unaccented here on purpose: `Dynamique` is plain ASCII, so only
 * the word list keeps it out of the name column.
 */
const LOCALIZED_LEASES = [
  '192.168.1.20,aa:bb:cc:dd:ee:01,Dynamique,cam-entree',
  '192.168.1.21    AA-BB-CC-DD-EE-02    Statique',
  '192.168.1.22,aa:bb:cc:dd:ee:03,dinamica,cam-garage',
  '',
].join('\n');

test('a localized lease state is never read as a host name', () => {
  const result = parseInventory(LOCALIZED_LEASES);
  assert.equal(result.format, 'leases');
  assert.deepEqual(
    result.devices.map((device) => device.hostname),
    ['cam-entree', '', 'cam-garage'],
    'the name after the state is kept; the state alone is not a name',
  );
});

test('a file that is not an inventory is refused, not guessed at', () => {
  assert.equal(parseInventory('name,colour\nfoo,red\n').format, null);
  assert.deepEqual(parseInventory('').devices, []);
  // An address with no MAC beside it is not a device the sweep can name.
  assert.equal(parseInventory('Gateway 192.168.1.1\n').format, null);
});

test('one host seen twice merges into the richer row', () => {
  const merged = parseInventory([XML_SCAN, XML_SCAN].join('\n'));
  assert.equal(merged.devices.length, 2);
});

test('the cap keeps what fits and says so', () => {
  const rows = Array.from({ length: 5 }, (_, index) => [
    `Nmap scan report for 192.168.1.${index + 10}`,
    'Host is up.',
    `MAC Address: 24:0A:C4:00:00:0${index} (Espressif)`,
    '',
  ]).join('\n');
  const result = parseInventory(rows, { limit: 3 });
  assert.equal(result.devices.length, 3);
  assert.equal(result.truncated, true);
});

test('a MAC prefix names a maker when nmap did not', () => {
  assert.equal(vendorForMac('44:19:B6:11:22:33'), 'Hikvision');
  assert.equal(vendorForMac('44-19-b6-11-22-33'), 'Hikvision');
  assert.equal(vendorForMac('3C:EF:8C:01:02:03'), 'Dahua');
  assert.equal(vendorForMac('00:40:8C:00:00:01'), 'Axis');
  assert.equal(vendorForMac('00:11:22:33:44:55'), '');
});

test('a prefix the shortlist cannot vouch for is not attributed', () => {
  // Espressif and Tuya own their blocks, but those blocks cover the radio
  // module: the same chip is in a lamp, a plug and a camera. Naming either as
  // the device's maker would print a guess as a fact.
  for (const mac of [
    '24:0A:C4:00:00:01',
    '10:D5:61:00:00:01',
    '84:E3:42:00:00:01',
  ])
    assert.equal(vendorForMac(mac), '', `${mac} is a module prefix`);
  // ...and these two were in no IEEE registry at all and are gone.
  for (const mac of ['AC:E6:B8:11:22:33', '08:3A:F8:11:22:33'])
    assert.equal(vendorForMac(mac), '', `${mac} is unregistered`);

  const result = parseInventory(
    [
      'Nmap scan report for 192.168.1.50',
      'Host is up.',
      'MAC Address: 24:0A:C4:AA:BB:CC',
      'Nmap done: 1 IP address (1 host up) scanned in 1.00 seconds',
      '',
    ].join('\n'),
  );
  const device = result.devices[0];
  assert.equal(device.vendor, '', 'no maker is claimed from a module prefix');
  assert.deepEqual(device.reasons, [], 'and it adds no evidence either way');
  assert.equal(device.verdict, 'unknown');
});

test('the verdict says what the evidence supports and nothing more', () => {
  assert.equal(
    classifyDevice({ ports: [{ port: 554, protocol: 'tcp' }] }).verdict,
    'camera',
    'RTSP is the strongest single signal',
  );
  assert.equal(
    classifyDevice({ mac: 'B8:27:EB:00:00:01' }).verdict,
    'iot',
    'a board maker with no ports is still not a printer',
  );
  assert.equal(
    classifyDevice({ vendor: 'Espressif' }).verdict,
    'iot',
    'a module maker the scan named itself is still read as a board',
  );
  assert.equal(
    classifyDevice({ ports: [{ port: 443, protocol: 'tcp' }] }).verdict,
    'network',
  );
  assert.deepEqual(classifyDevice({}).reasons, []);
  assert.equal(classifyDevice({}).verdict, 'unknown');
  assert.deepEqual(
    classifyDevice({
      vendor: 'Hikvision',
      ports: [{ port: 554, protocol: 'tcp' }],
    }).reasons.map((reason) => reason.code),
    ['rtsp', 'vendor'],
    'a reason list is shown, not just a score',
  );
});

test('one address-and-MAC line is not a list, so the file is refused', () => {
  const single = '192.168.1.10,aa:bb:cc:dd:ee:ff,laptop-living-room';
  assert.equal(
    parseInventory(single).format,
    null,
    'a file quoting one address and one MAC is not an inventory',
  );
  assert.deepEqual(parseInventory(single).devices, []);
});

/** The shape `arp -a` prints on Windows: interface, column header, entries. */
const WINDOWS_ARP = [
  '',
  'Interface: 192.168.1.100 --- 0xb',
  '  Internet Address      Physical Address      Type',
  '  192.168.1.1           00-11-22-33-44-55     dynamic',
  '  192.168.1.42          44-19-b6-11-22-33     dynamic',
  '',
].join('\n');

test("Windows' arp table is still read, and its rows are leases", () => {
  const result = parseInventory(WINDOWS_ARP);
  assert.equal(result.format, 'leases');
  assert.deepEqual(
    result.devices.map((device) => device.ip),
    ['192.168.1.1', '192.168.1.42'],
    'the interface line and the column header hold no lease',
  );
  assert.equal(result.devices[1].mac, '44:19:B6:11:22:33');
  assert.equal(result.devices[1].verdict, 'camera');
});

/** In-memory Storage for the store tests. */
function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test('a scan and its place round-trip, and clearing keeps the place', () => {
  const storage = fakeStorage();
  const store = createDeviceSweepStore({ storage, now: () => 1234 });
  assert.deepEqual(store.read(), {
    devices: [],
    place: null,
    importedAt: null,
    name: '',
    notes: {},
  });
  const { devices } = parseInventory(NORMAL_SWEEP);
  store.write({ devices, name: 'scan.txt' });
  store.setPlace({ lat: 48.85, lon: 2.35 });
  const read = store.read();
  assert.equal(read.devices.length, 3);
  assert.equal(read.name, 'scan.txt');
  assert.deepEqual(read.place, { lat: 48.85, lon: 2.35 });
  assert.equal(
    read.devices.find((device) => device.ip === '192.168.1.42').verdict,
    'camera',
    'the verdict survives the round-trip',
  );
  store.clear();
  const cleared = store.read();
  assert.deepEqual(cleared.devices, []);
  assert.deepEqual(cleared.place, { lat: 48.85, lon: 2.35 });
  assert.equal(storage.map.has(DEVICE_SWEEP_STORAGE_KEY), true);
});

test('a second import names what is new and keeps when the rest was seen', () => {
  const storage = fakeStorage();
  let clock = 1000;
  const store = createDeviceSweepStore({ storage, now: () => clock });
  const device = (ip, mac) => ({ ip, mac });

  const first = store.write({
    devices: [
      device('192.168.1.10', 'AA:BB:CC:00:00:01'),
      device('192.168.1.11', 'AA:BB:CC:00:00:02'),
    ],
  });
  assert.equal(first.added, 2, 'everything is new in the first import');

  clock = 2000;
  const second = store.write({
    devices: [
      device('192.168.1.10', 'AA:BB:CC:00:00:01'),
      device('192.168.1.11', 'AA:BB:CC:00:00:02'),
      device('192.168.1.12', 'AA:BB:CC:00:00:03'),
    ],
  });
  assert.equal(second.added, 1, 'only the third device is new');
  const read = store.read();
  assert.equal(
    read.devices.find((entry) => entry.ip === '192.168.1.10').firstSeen,
    1000,
    'a device seen before keeps its first date',
  );
  assert.equal(
    read.devices.find((entry) => entry.ip === '192.168.1.12').firstSeen,
    2000,
  );

  clock = 3000;
  assert.equal(
    store.write({ devices: [device('192.168.1.12', 'AA:BB:CC:00:00:03')] })
      .added,
    0,
    'repeating an import adds nothing',
  );
});

test('a note follows its device across imports, and leaves with the scan', () => {
  const storage = fakeStorage();
  let clock = 1;
  const store = createDeviceSweepStore({ storage, now: () => clock });
  const camera = { ip: '192.168.1.42', mac: '44:19:B6:11:22:33' };

  store.write({ devices: [camera] });
  store.setNote('44:19:B6:11:22:33', '  camera above the door  ');
  assert.equal(
    store.read().devices[0].note,
    'camera above the door',
    'the note is trimmed and read back with its device',
  );

  clock = 2;
  store.write({
    devices: [camera, { ip: '192.168.1.7', mac: 'AA:BB:CC:00:00:09' }],
  });
  const read = store.read();
  assert.equal(read.notes['44:19:B6:11:22:33'], 'camera above the door');
  assert.equal(
    read.devices.find((entry) => entry.ip === '192.168.1.7').note,
    '',
    'a device the operator never wrote about carries no note',
  );

  store.setNote('44:19:B6:11:22:33', 'x'.repeat(400));
  assert.equal(
    store.read().notes['44:19:B6:11:22:33'].length,
    280,
    'a note is bounded',
  );

  store.clear();
  assert.deepEqual(store.read().notes, {}, 'clearing the scan loses its notes');
});

test('a broken or oversized store is a refusal with a reason, never a crash', () => {
  const storage = fakeStorage();
  storage.setItem(DEVICE_SWEEP_STORAGE_KEY, '{not json');
  const store = createDeviceSweepStore({ storage });
  assert.deepEqual(store.read().devices, []);

  const unavailable = createDeviceSweepStore({ storage: null });
  assert.deepEqual(unavailable.read().devices, []);
  assert.throws(
    () => unavailable.write({ devices: [] }),
    (error) =>
      error instanceof DeviceSweepStoreError && error.code === 'unavailable',
  );
});

test('devices are drawn in a ring around the declared place, flagged first', () => {
  const place = { lat: 48.85, lon: 2.35 };
  const first = sweepPointFor(place, 0);
  const second = sweepPointFor(place, 1);
  assert.notDeepEqual(first, second, 'two devices never share a point');
  assert.ok(Math.abs(first.lat - place.lat) < 0.001);
  assert.ok(Math.abs(first.lon - place.lon) < 0.001);

  const { devices } = parseInventory(NORMAL_SWEEP);
  const bounds = {
    west: place.lon - 0.01,
    south: place.lat - 0.01,
    east: place.lon + 0.01,
    north: place.lat + 0.01,
  };
  const { rows, matched } = devicesInBounds(devices, place, bounds);
  assert.equal(matched, 3);
  assert.equal(rows[0].meta.verdict, 'camera', 'the flagged device is nearest');
  assert.equal(rows[0].meta.local, true);
  assert.equal(rows[0].meta.ports, '80/tcp, 554/tcp, 8000/tcp');
});

test('no place, or a view that does not hold it, is an empty answer', async () => {
  const { devices } = parseInventory(NORMAL_SWEEP);
  const bounds = { west: 2.3, south: 48.8, east: 2.4, north: 48.9 };
  assert.deepEqual(devicesInBounds(devices, null, bounds).rows, []);
  assert.deepEqual(
    devicesInBounds(devices, { lat: 43.3, lon: 5.4 }, bounds).rows,
    [],
  );

  const source = createDeviceSweepSource({
    store: { read: () => ({ devices, place: null }) },
  });
  const snapshot = await source.getSnapshot({ bounds });
  assert.deepEqual(snapshot.rows, []);
  assert.equal(snapshot.truncated, false);
});

test('the source answers from the store only, and never reaches the network', async () => {
  const { devices } = parseInventory(NORMAL_SWEEP);
  const store = { read: () => ({ devices, place: { lat: 48.85, lon: 2.35 } }) };
  const source = createDeviceSweepSource({ store });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('the device sweep must never reach the network');
  };
  try {
    const snapshot = await source.getSnapshot({
      bounds: { west: 2.3, south: 48.8, east: 2.4, north: 48.9 },
    });
    assert.equal(snapshot.rows.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
