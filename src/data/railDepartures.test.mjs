import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RAIL_BOARD_LIMIT,
  buildStationBoard,
  nearestStation,
  parseGtfsStops,
} from './railDepartures.js';

const STOPS = [
  'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station',
  'NANTES,Nantes,47.2173,-1.5421,1,',
  'NANTES_1,,47.2174,-1.5422,0,NANTES',
  'NANTES_2,,47.2172,-1.5420,0,NANTES',
  'RENNES,Rennes,48.1035,-1.6725,1,',
  'RENNES_1,,48.1036,-1.6726,0,RENNES',
  'BROKEN,Broken,,,0,RENNES',
].join('\n');

function index(text = STOPS) {
  const parsed = parseGtfsStops(text);
  const stopArea = new Map();
  for (const area of parsed.areas) stopArea.set(area.id, area.id);
  for (const [areaId, stopIds] of parsed.areaStops) {
    for (const stopId of stopIds) stopArea.set(stopId, areaId);
  }
  return { ...parsed, stopArea };
}

function board(trips, overrides = {}) {
  const station = index();
  return buildStationBoard({
    trips,
    areaId: 'NANTES',
    areaStops: station.areaStops,
    areaById: station.areaById,
    stopArea: station.stopArea,
    now: 1_000,
    ...overrides,
  });
}

test('parseGtfsStops keeps stations, maps platforms, and skips unusable rows', () => {
  const station = index();
  assert.deepEqual(
    station.areas.map((area) => area.id),
    ['NANTES', 'RENNES'],
  );
  assert.equal(station.areas[0].name, 'Nantes');
  assert.deepEqual(station.areaStops.get('NANTES'), ['NANTES_1', 'NANTES_2']);
  // The row without coordinates is dropped rather than placed at (0,0).
  assert.equal(station.truncated, false);
  assert.equal(station.areas.length, 2);
});

test('parseGtfsStops unquotes a quoted station name', () => {
  const station = index(
    [
      'stop_id,stop_name,stop_lat,stop_lon,location_type',
      'X,"Gare de Lyon, Paris",48.8443,2.3743,1',
    ].join('\n'),
  );
  assert.equal(station.areas[0].name, 'Gare de Lyon, Paris');
});

test('parseGtfsStops refuses a file missing the columns a board needs', () => {
  assert.throws(
    () => parseGtfsStops('stop_id,stop_name\nA,Nantes'),
    /missing the columns/,
  );
});

test('nearestStation matches by position and refuses a distant one', () => {
  const { areas } = index();
  const found = nearestStation(areas, 47.2175, -1.542);
  assert.equal(found.area.id, 'NANTES');
  assert.ok(found.distanceKm < 0.8);
  // Paris is hundreds of kilometres from either station: no board, rather than
  // the nearest one in another region.
  assert.equal(nearestStation(areas, 48.8566, 2.3522), null);
  assert.equal(nearestStation(areas, Number.NaN, 2), null);
});

test('buildStationBoard lists departures in expected order', () => {
  const result = board([
    {
      tripId: 'late',
      routeId: 'TER',
      stops: [
        { stopId: 'NANTES_1', departureTime: 1_600, delay: 300 },
        { stopId: 'RENNES_1', arrivalTime: 5_000 },
      ],
    },
    {
      tripId: 'ontime',
      stops: [
        { stopId: 'NANTES_2', departureTime: 2_400 },
        { stopId: 'RENNES_1', arrivalTime: 6_000 },
      ],
    },
  ]);
  assert.equal(result.considered, 2);
  // Ordered by the time the train is now expected to leave (1_600 + 300 s),
  // not by the timetable it was booked on.
  assert.deepEqual(
    result.departures.map((entry) => entry.tripId),
    ['late', 'ontime'],
  );
  const late = result.departures[0];
  assert.equal(late.at, 1_600);
  assert.equal(late.expectedAt, 1_900);
  assert.equal(late.delaySeconds, 300);
  assert.equal(late.destination, 'Rennes');
});

test('buildStationBoard drops a train that terminates here and one long gone', () => {
  const result = board([
    {
      tripId: 'terminates',
      stops: [{ stopId: 'NANTES_1', arrivalTime: 1_100 }],
    },
    {
      tripId: 'gone',
      stops: [
        { stopId: 'NANTES_1', departureTime: 800 },
        { stopId: 'RENNES_1', arrivalTime: 3_000 },
      ],
    },
    {
      tripId: 'soon',
      stops: [
        { stopId: 'NANTES_1', departureTime: 1_200 },
        { stopId: 'RENNES_1', arrivalTime: 3_400 },
      ],
    },
  ]);
  // The terminated trip and the one that left 200 s ago are counted, not listed.
  assert.equal(result.considered, 3);
  assert.deepEqual(
    result.departures.map((entry) => entry.tripId),
    ['soon'],
  );
});

test('buildStationBoard names an unknown last stop as nothing rather than guessing', () => {
  const result = board([
    {
      tripId: 'abroad',
      stops: [
        { stopId: 'NANTES_1', departureTime: 1_200 },
        { stopId: 'LYON_1', arrivalTime: 9_000 },
      ],
    },
  ]);
  assert.equal(result.departures.length, 1);
  assert.equal(result.departures[0].destination, null);
});

test('buildStationBoard marks a cancelled trip and caps the board', () => {
  const trips = Array.from({ length: RAIL_BOARD_LIMIT + 4 }, (_, i) => ({
    tripId: `t${i}`,
    cancelled: i === 0,
    stops: [
      { stopId: 'NANTES_1', departureTime: 1_200 + i * 60 },
      { stopId: 'RENNES_1', arrivalTime: 4_000 + i * 60 },
    ],
  }));
  const result = board(trips);
  assert.equal(result.departures.length, RAIL_BOARD_LIMIT);
  assert.equal(result.departures[0].cancelled, true);
  assert.deepEqual(
    result.departures.map((entry) => entry.at),
    [...result.departures.map((entry) => entry.at)].sort((a, b) => a - b),
  );
});

test('buildStationBoard reports nothing for a station with no running trip', () => {
  const result = board([
    {
      tripId: 'other',
      stops: [
        { stopId: 'RENNES_1', departureTime: 1_200 },
        { stopId: 'BREST_1', arrivalTime: 9_000 },
      ],
    },
  ]);
  assert.deepEqual(result.departures, []);
  assert.equal(result.considered, 0);
});
