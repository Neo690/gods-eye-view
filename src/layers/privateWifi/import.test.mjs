import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWigleCsv, splitCsvLine } from './csv.js';
import {
  PRIVATE_WIFI_MAX_BYTES,
  PRIVATE_WIFI_STORAGE_KEY,
  PrivateWifiStoreError,
  createPrivateWifiStore,
} from './store.js';
import { createPrivateWifiSource, networksInBounds } from './source.js';

/** The shape a WiGLE 1.4 export actually has, preamble and all. */
const WIGLE_HEADER =
  'MAC,SSID,AuthMode,FirstSeen,Channel,Frequency,RSSI,CurrentLatitude,CurrentLongitude,AltitudeMeters,AccuracyMeters,Type';
const WIGLE_CSV = [
  'WigleWifi-1.4,appRelease=2.6,model=Pixel,release=14,device=raven,display=,board=,brand=google',
  WIGLE_HEADER,
  'AA:BB:CC:DD:EE:01,"Cafe, Coin",[WPA2-PSK-CCMP][ESS],2024-05-01 10:00:00,6,2437,-71,48.8566,2.3522,35,8,WIFI',
  'AA:BB:CC:DD:EE:01,"Cafe, Coin",[WPA2-PSK-CCMP][ESS],2024-05-01 10:05:00,6,2437,-55,48.8570,2.3530,35,6,WIFI',
  'AA:BB:CC:DD:EE:02,"He said ""hi""",[WPA2-PSK-CCMP][ESS],2024-05-01 10:01:00,11,2462,-80,48.86,2.36,35,9,WIFI',
  'AA:BB:CC:DD:EE:03,NoFix,[ESS],2024-05-01 10:02:00,1,2412,-90,0,0,0,0,WIFI',
  'AA:BB:CC:DD:EE:04,BlueTooth,[BLE],2024-05-01 10:03:00,0,2402,-60,48.85,2.35,0,5,BLE',
  'AA:BB:CC:DD:EE:05,Hidden,[ESS],2024-05-01 10:04:00,1,2412,-65,,,0,0,WIFI',
  '',
].join('\r\n');

test('a WiGLE export is read past its preamble, quotes and CRLF', () => {
  assert.deepEqual(splitCsvLine('a,"b,c","d""e",f'), ['a', 'b,c', 'd"e', 'f']);
  const result = parseWigleCsv(WIGLE_CSV);
  assert.equal(result.header, true);
  assert.equal(result.networks.length, 2, 'two placed, distinct networks');
  const [cafe, quoted] = result.networks;
  assert.equal(cafe.ssid, 'Cafe, Coin');
  assert.equal(cafe.mac, 'AA:BB:CC:DD:EE:01');
  assert.equal(cafe.channel, 6);
  assert.equal(
    cafe.observations,
    2,
    'the same access point seen twice is one network',
  );
  assert.equal(cafe.rssi, -55, 'the strongest observation wins');
  assert.equal(cafe.lat, 48.857, 'and its position comes with it');
  assert.equal(quoted.ssid, 'He said "hi"');
  assert.equal(
    result.skipped,
    3,
    'no fix, Bluetooth and an unplaced row are skipped',
  );
  assert.equal(
    result.observations,
    3,
    'only placed Wi-Fi rows count as observations',
  );
});

test('a file that is not a WiGLE export is refused, not guessed at', () => {
  const result = parseWigleCsv('name,colour\nfoo,red\n');
  assert.equal(result.header, false);
  assert.deepEqual(result.networks, []);
  assert.equal(parseWigleCsv('').header, false);
});

test('the cap keeps what fits and says so', () => {
  const rows = Array.from({ length: 5 }, (_, index) => {
    const mac = `AA:BB:CC:DD:EF:0${index}`;
    return `${mac},net${index},[ESS],2024-05-01 10:00:00,1,2412,-60,48.8${index},2.3${index},0,5,WIFI`;
  });
  const result = parseWigleCsv([WIGLE_HEADER, ...rows].join('\n'), {
    limit: 3,
  });
  assert.equal(result.networks.length, 3);
  assert.equal(result.truncated, true);
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

test('an import round-trips through storage and can be cleared', () => {
  const storage = fakeStorage();
  const store = createPrivateWifiStore({ storage, now: () => 1234 });
  assert.deepEqual(store.read(), {
    networks: [],
    importedAt: null,
    name: '',
  });
  const written = store.write({
    networks: [
      {
        mac: 'AA:BB:CC:DD:EE:01',
        ssid: 'Cafe',
        lat: 48.85,
        lon: 2.35,
        rssi: -55,
        channel: 6,
        observations: 4,
      },
    ],
    name: 'wardrive.csv',
  });
  assert.equal(written.importedAt, 1234);
  const read = store.read();
  assert.equal(read.networks.length, 1);
  assert.deepEqual(read.networks[0], {
    lat: 48.85,
    lon: 2.35,
    mac: 'AA:BB:CC:DD:EE:01',
    ssid: 'Cafe',
    rssi: -55,
    channel: 6,
    observations: 4,
  });
  assert.equal(read.name, 'wardrive.csv');
  store.clear();
  assert.deepEqual(store.read().networks, []);
  assert.equal(storage.map.has(PRIVATE_WIFI_STORAGE_KEY), false);
});

test('a broken or oversized store is a refusal with a reason, never a crash', () => {
  const storage = fakeStorage();
  storage.setItem(PRIVATE_WIFI_STORAGE_KEY, '{not json');
  const store = createPrivateWifiStore({ storage });
  assert.deepEqual(store.read().networks, []);

  const huge = {
    networks: Array.from({ length: 400 }, (_, index) => ({
      mac: `AA:BB:CC:DD:FF:${index}`,
      ssid: 'x'.repeat(PRIVATE_WIFI_MAX_BYTES / 300),
      lat: 48.85,
      lon: 2.35,
    })),
  };
  assert.throws(
    () => store.write(huge),
    (error) =>
      error instanceof PrivateWifiStoreError && error.code === 'too-large',
  );
  assert.equal(
    storage.getItem(PRIVATE_WIFI_STORAGE_KEY),
    '{not json',
    'nothing was replaced',
  );

  const unavailable = createPrivateWifiStore({ storage: null });
  assert.deepEqual(unavailable.read().networks, []);
  assert.throws(
    () => unavailable.write({ networks: [] }),
    (error) => error.code === 'unavailable',
  );
});

test('the source answers from the file only, inside the view', async () => {
  const networks = [
    { mac: 'A', ssid: 'in', lat: 48.85, lon: 2.35 },
    { mac: 'B', ssid: 'out', lat: 43.3, lon: 5.4 },
    { mac: 'C', ssid: '', lat: 48.86, lon: 2.36 },
  ];
  const inView = networksInBounds(networks, {
    west: 2.3,
    south: 48.8,
    east: 2.4,
    north: 48.9,
  });
  assert.equal(inView.matched, 2);
  assert.deepEqual(
    inView.rows.map((row) => row.id),
    ['A', 'C'],
  );
  assert.equal(
    inView.rows[1].label,
    'C',
    'a hidden SSID falls back to its MAC',
  );
  assert.equal(inView.rows[0].meta.local, true);

  const store = { read: () => ({ networks }) };
  const source = createPrivateWifiSource({ store });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('the private Wi-Fi layer must never reach the network');
  };
  try {
    const snapshot = await source.getSnapshot({
      bounds: { west: 2.3, south: 48.8, east: 2.4, north: 48.9 },
    });
    assert.equal(snapshot.rows.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an empty store is an empty answer, not an error', async () => {
  const source = createPrivateWifiSource({
    store: { read: () => ({ networks: [] }) },
  });
  const snapshot = await source.getSnapshot({
    bounds: { west: 2.3, south: 48.8, east: 2.4, north: 48.9 },
  });
  assert.deepEqual(snapshot.rows, []);
  assert.equal(snapshot.truncated, false);
});
