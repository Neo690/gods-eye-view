import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INCIDENT_LIMITS,
  incidentCellKey,
  rankIncidents,
  scanIncidents,
} from './incidentScan.js';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const minutesAgo = (minutes) => NOW - minutes * 60 * 1000;

const flight = (overrides = {}) => ({
  icao24: 'abc123',
  callsign: 'TEST123',
  lat: 48.85,
  lon: 2.35,
  onGround: false,
  squawk: null,
  emergency: false,
  emergencyKind: null,
  emergencySource: null,
  lastContactAtMs: minutesAgo(1),
  military: false,
  ...overrides,
});

test('no sources means no incidents', () => {
  assert.deepEqual(scanIncidents({}, { now: NOW }), []);
});

test('an aircraft broadcasting 7700 is a critical incident quoting the code', () => {
  const incidents = scanIncidents(
    {
      flights: [
        flight({
          emergency: true,
          emergencyKind: 'general',
          emergencySource: 'squawk',
          squawk: '7700',
        }),
      ],
    },
    { now: NOW },
  );
  assert.equal(incidents.length, 1);
  const [incident] = incidents;
  assert.equal(incident.id, 'aircraft-emergency:abc123');
  assert.equal(incident.severity, 'critical');
  assert.equal(incident.title.key, 'Aircraft emergency — {aircraft}');
  assert.equal(incident.title.params.aircraft, 'TEST123');
  assert.equal(incident.detail.key, 'Squawk {squawk} — {status}');
  assert.deepEqual(incident.detail.params, {
    squawk: '7700',
    status: { messageKey: 'General emergency' },
  });
});

test('an ADS-B emergency with no squawk is attributed to ADS-B', () => {
  const [incident] = scanIncidents(
    {
      flights: [
        flight({
          emergency: true,
          emergencyKind: 'nordo',
          emergencySource: 'ads-b',
        }),
      ],
    },
    { now: NOW },
  );
  assert.equal(incident.detail.key, 'ADS-B emergency — {status}');
  assert.deepEqual(incident.detail.params, {
    status: { messageKey: 'Radio failure' },
  });
});

test('a 7x00 squawk that is not flagged is not an incident', () => {
  assert.deepEqual(
    scanIncidents({ flights: [flight({ squawk: '7700' })] }, { now: NOW }),
    [],
  );
});

test('one airframe reported by both layers is one incident', () => {
  const emergency = {
    emergency: true,
    emergencyKind: 'general',
    emergencySource: 'squawk',
    squawk: '7700',
  };
  const incidents = scanIncidents(
    {
      flights: [flight(emergency)],
      military: [flight({ ...emergency, military: true })],
    },
    { now: NOW },
  );
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].layerId, 'flights');
});

test('earthquakes need M5, a recent time and a position', () => {
  const quake = (overrides = {}) => ({
    id: 'us1',
    magnitude: 5.4,
    depthKm: 12,
    lat: -20,
    lon: -70,
    place: '10 km N of Somewhere',
    timeMs: minutesAgo(60),
    ...overrides,
  });
  assert.equal(
    scanIncidents({ earthquakes: [quake({ magnitude: 4.9 })] }, { now: NOW })
      .length,
    0,
  );
  assert.equal(
    scanIncidents(
      {
        earthquakes: [
          quake({ timeMs: NOW - INCIDENT_LIMITS.quakeWindowMs - 1 }),
        ],
      },
      { now: NOW },
    ).length,
    0,
  );
  assert.equal(
    scanIncidents({ earthquakes: [quake({ lat: null })] }, { now: NOW }).length,
    0,
  );
  const [incident] = scanIncidents({ earthquakes: [quake()] }, { now: NOW });
  assert.equal(incident.title.key, 'Earthquake M{magnitude} — {place}');
  assert.equal(incident.severity, 'warning');
  assert.equal(incident.detail.key, 'Depth {depth} km');

  const [major] = scanIncidents(
    { earthquakes: [quake({ id: 'us2', magnitude: 6.9, place: null })] },
    { now: NOW },
  );
  assert.equal(major.severity, 'critical');
  assert.equal(major.title.key, 'Earthquake M{magnitude}');
});

test('a fire cluster needs strong, recent, confident detections', () => {
  const fire = (index, overrides = {}) => ({
    id: `FIRE-${index}`,
    lat: -10.2 + index * 0.01,
    lon: -55.3 + index * 0.01,
    frp: 180,
    confidence: 0.8,
    acqTime: minutesAgo(30),
    ...overrides,
  });
  const fires = (count, overrides = {}) =>
    Array.from({ length: count }, (_, index) => fire(index, overrides));

  assert.equal(scanIncidents({ fires: fires(4) }, { now: NOW }).length, 0);

  const [incident] = scanIncidents({ fires: fires(5) }, { now: NOW });
  assert.equal(incident.title.key, 'Wildfire cluster — {count} intense fires');
  assert.equal(incident.title.params.count, 5);
  assert.equal(incident.detail.key, 'Strongest detection {frp} MW');
  assert.equal(incident.detail.params.frp, 180);

  assert.equal(
    scanIncidents({ fires: fires(5, { frp: 40 }) }, { now: NOW }).length,
    0,
  );
  assert.equal(
    scanIncidents({ fires: fires(5, { confidence: 0.1 }) }, { now: NOW })
      .length,
    0,
  );
  assert.equal(
    scanIncidents(
      { fires: fires(5, { acqTime: minutesAgo(60 * 30) }) },
      { now: NOW },
    ).length,
    0,
  );
});

test('a hurricane is critical, a tropical storm is a warning', () => {
  const storm = (name, windKt, classification) => ({
    id: name,
    name,
    classification,
    lat: 18.4,
    lon: -63.2,
    windKt,
    pressureHpa: 960,
  });
  const incidents = scanIncidents(
    {
      cyclones: [storm('ERIN', 95, 'HU'), storm('FERN', 40, 'TS')],
    },
    { now: NOW },
  );
  assert.deepEqual(
    incidents.map((incident) => incident.severity),
    ['critical', 'warning'],
  );
  assert.equal(incidents[0].id, 'cyclone:ERIN');
  assert.deepEqual(incidents[0].title.params.classification, {
    messageKey: 'Hurricane',
  });
  assert.equal(
    incidents[1].title.params.classification.messageKey,
    'Tropical storm',
  );
});

test('military contacts must concentrate before they are reported', () => {
  const contact = (index) =>
    flight({
      icao24: `mil${index}`,
      lat: 34.1 + index * 0.05,
      lon: 35.5 + index * 0.05,
      military: true,
    });
  const contacts = (count) =>
    Array.from({ length: count }, (_, i) => contact(i));

  assert.equal(
    scanIncidents(
      { military: contacts(INCIDENT_LIMITS.militaryClusterSize - 1) },
      { now: NOW },
    ).length,
    0,
  );
  const [incident] = scanIncidents(
    { military: contacts(INCIDENT_LIMITS.militaryClusterSize) },
    { now: NOW },
  );
  assert.equal(incident.kind, 'military');
  assert.equal(
    incident.title.params.count,
    INCIDENT_LIMITS.militaryClusterSize,
  );
  assert.equal(
    scanIncidents(
      {
        military: contacts(INCIDENT_LIMITS.militaryClusterSize).map((row) => ({
          ...row,
          onGround: true,
        })),
      },
      { now: NOW },
    ).length,
    0,
  );
});

test('degraded GNSS integrity is one incident, and a single cell is not', () => {
  assert.deepEqual(
    scanIncidents(
      { gnss: { levels: { low: 1, medium: 3, high: 5 } } },
      { now: NOW },
    ),
    [],
  );
  const [incident] = scanIncidents(
    { gnss: { levels: { low: 4, medium: 3, high: 5 } } },
    { now: NOW },
  );
  assert.equal(incident.id, 'gnss:degraded');
  assert.equal(incident.title.params.count, 4);
  assert.equal(incident.lat, null);
});

test('critical incidents are listed before warnings', () => {
  const incidents = scanIncidents(
    {
      earthquakes: [
        {
          id: 'us3',
          magnitude: 5.1,
          depthKm: 10,
          lat: 1,
          lon: 1,
          place: null,
          timeMs: minutesAgo(20),
        },
      ],
      flights: [
        flight({
          emergency: true,
          emergencyKind: 'general',
          emergencySource: 'squawk',
          squawk: '7700',
        }),
      ],
    },
    { now: NOW },
  );
  assert.deepEqual(
    incidents.map((incident) => incident.severity),
    ['critical', 'warning'],
  );
});

test('the ranking is shared, so a zone alert is ordered against a scan alert', () => {
  const listed = rankIncidents(
    [
      { id: 'zone:1', severity: 'warning', atMs: minutesAgo(3) },
      { id: 'quake:1', severity: 'critical', atMs: minutesAgo(30) },
      { id: 'zone:1', severity: 'warning', atMs: minutesAgo(3) },
      { id: 'fire:1', severity: 'warning', atMs: minutesAgo(2) },
      { severity: 'critical', atMs: NOW },
    ],
    { limits: INCIDENT_LIMITS },
  );
  assert.deepEqual(
    listed.map((incident) => incident.id),
    ['quake:1', 'fire:1', 'zone:1'],
    'critical first, then the most recent; the duplicate id and the id-less entry are dropped',
  );
});

test('the ranking caps the list and keeps ties in a stable order', () => {
  const incidents = ['b', 'a', 'c'].map((name) => ({
    id: name,
    severity: 'warning',
    atMs: NOW,
  }));
  assert.deepEqual(
    rankIncidents(incidents, { limits: { maxIncidents: 2 } }).map((i) => i.id),
    ['a', 'b'],
  );
  assert.deepEqual(rankIncidents(), []);
});

test('grid keys separate neighbouring cells and stay inside the longitude range', () => {
  assert.equal(incidentCellKey(10.1, 20.1, 5), incidentCellKey(10.9, 20.9, 5));
  assert.notEqual(
    incidentCellKey(10.1, 20.1, 5),
    incidentCellKey(15.1, 20.1, 5),
  );
  assert.equal(incidentCellKey(0, 180, 5), '0:0');
  assert.equal(incidentCellKey(0, -180, 5), '0:0');
  assert.equal(incidentCellKey(0, -179.9, 5), '0:0');
  assert.equal(incidentCellKey(0, 179.9, 5), '0:71');
});
