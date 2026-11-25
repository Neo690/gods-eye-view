/**
 * Deterministic network fixtures for the layer-activation matrix.
 *
 * Every fixture answers one source the app's layer actually reads, so the
 * matrix can enable a layer with the network cut off from the live internet
 * and still exercise its real parser, renderer and teardown path. Recorded
 * payloads live in ./data; the synthetic payloads below keep only the fields
 * the layer's validator requires, at coordinates over Austin, Texas. Air
 * quality is the exception: its AQHI fixture spans Canada because that is the
 * provider's coverage, and the Air quality QA harness asserts multiple zones
 * and an in-view readout after moving the camera over Canada.
 *
 * The module is deliberately browser-free so the fixture registry can be
 * checked in Node (and by --self-check) without launching Chrome.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trafficFixtureResponse } from '../../traffic-fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const dataPath = (name) => resolve(HERE, 'data', name);
const readJson = (name) => JSON.parse(readFileSync(dataPath(name), 'utf8'));
const readBuffer = (name) => readFileSync(dataPath(name));

const CORS = { 'access-control-allow-origin': '*' };
const json = (body, status = 200, headers = {}) => ({
  status,
  headers: {
    ...CORS,
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  },
  body: JSON.stringify(body),
});
const text = (body, contentType = 'text/plain; charset=utf-8') => ({
  status: 200,
  headers: { ...CORS, 'content-type': contentType },
  body,
});
const binary = (body, contentType = 'application/octet-stream') => ({
  status: 200,
  headers: { ...CORS, 'content-type': contentType },
  body,
});
const png = () => binary(readBuffer('pixel.png'), 'image/png');

const HOUR = 60 * 60 * 1000;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const roundHour = (ms = Date.now()) => Math.floor(ms / HOUR) * HOUR;

export const AUSTIN = Object.freeze({ lat: 30.2672, lon: -97.7431 });

const recordedFlights = readJson('flights.json');
const recordedMilitary = readJson('military.json');
const recordedRadiation = readJson('radiation.json');
const recordedSpaceWeather = readJson('space-weather.json');
const recordedGnss = readJson('gnss.json');
const recordedRadio = readJson('radio.json');
const recordedVehicles = readJson('transit-vehicles.json');
const recordedCctv = readJson('cctv-sources.json');
const recordedTle = readJson('tle-catalogue.json');
const recordedFires = readJson('fire-perimeters.json');
const recordedGhostmaps = readJson('ghostmaps.json');
const recordedWind = readJson('wind.json');
const tleText = readFileSync(dataPath('tle.txt'), 'utf8');
const windGrid = readBuffer('wind-grid.bin');

const tleMembers = recordedTle.member;
const tleFor = (satelliteId) => {
  const member = tleMembers.find(
    (row) => String(row.satelliteId) === String(satelliteId),
  );
  return member
    ? `${member.name}\n${member.line1}\n${member.line2}\n`
    : tleText;
};

const weatherManifest = (product) => {
  const latest = iso(roundHour(Date.now() - 10 * 60_000));
  const previous = iso(roundHour(Date.now() - 70 * 60_000));
  return {
    schemaVersion: 1,
    product,
    bounds: { west: -180, south: -60, east: 180, north: 80 },
    times: [previous, latest],
    latest,
    tileSize: 256,
    maxLevel: 6,
    tilingScheme: 'geographic',
  };
};

const transitFeed = {
  id: 'qa-transit',
  name: 'QA Transit',
  operator: 'QA Transit Authority',
  region: 'Austin, TX',
  center: AUSTIN,
  loadRadiusKm: 80,
  license: 'QA fixture',
  licenseUrl: 'https://example.test/qa',
  attribution: 'QA Transit fixture',
  historyRetention: false,
};

const transitVehicles = {
  ...recordedVehicles,
  feedId: transitFeed.id,
  name: transitFeed.name,
  fetchedAt: Date.now(),
  vehicles: recordedVehicles.vehicles.map((vehicle, index) => ({
    ...vehicle,
    lat: AUSTIN.lat + index * 0.01,
    lon: AUSTIN.lon + index * 0.01,
    timestamp: Math.floor(Date.now() / 1000),
  })),
};

const cycloneStorm = {
  id: 'al092026',
  name: 'QA Storm',
  classification: 'TS',
  basin: 'AL',
  position: { longitude: -70.5, latitude: 25.4 },
  positionAt: iso(Date.now() - HOUR),
  issuedAt: iso(Date.now() - 2 * HOUR),
  advisoryNumber: '7',
  windKt: 45,
  pressureHpa: 1002,
  geometryStatus: 'pending',
  geometryAdvisoryNumber: null,
  forecastPoints: [],
  track: null,
  cone: null,
  movement: { directionDegrees: 315, speedKt: 8 },
  advisoryUrl: 'https://www.nhc.noaa.gov/text/MIATCMEP5.shtml',
  outlookUrl: null,
};

const acledDate = new Date(Date.now() - 6 * HOUR).toISOString().slice(0, 10);
const acledRows = Array.from({ length: 5 }, (_, index) => ({
  event_id_cnty: `QA-${index + 1}`,
  event_date: acledDate,
  event_type: 'Battles',
  sub_event_type: 'Armed clash',
  actor1: 'QA Force',
  actor2: 'QB Force',
  country: 'Qalandia',
  latitude: AUSTIN.lat + index * 0.02,
  longitude: AUSTIN.lon + index * 0.02,
  fatalities: index + 1,
}));

const qaFires = Array.from({ length: 5 }, (_, index) => ({
  lat: AUSTIN.lat + index * 0.03,
  lon: AUSTIN.lon + index * 0.03,
  frp: 10 + index * 5,
  confidence: index % 2 ? 'nominal' : 'high',
  brightness: 330 + index,
  daynight: 'D',
  acqDate: iso(Date.now()).slice(0, 10),
  acqTime: '1200',
  satellite: 'N',
  instrument: 'VIIRS',
}));

const qaCells = Array.from({ length: 9 }, (_, index) => ({
  lat: 27.5 + (index % 3) * 0.1,
  lon: -90.5 + Math.floor(index / 3) * 0.1,
  hours: 2 + index,
}));

// AQHI covers Canada, and the Air quality QA harness asserts multiple ECCC
// administrative zones plus an in-view readout after moving the camera over
// Canada. One Austin station could not satisfy either check. The values include
// a decimal and "10+" territory so the fixture also exercises the published
// integer form the source promises.
const aqhiFixtureStations = Object.freeze([
  {
    id: 'qa-aqhi-yvr',
    name: 'QA Vancouver',
    lat: 49.2827,
    lon: -123.1207,
    zone: 'pyr',
    aqhi: 2.4,
  },
  {
    id: 'qa-aqhi-yyc',
    name: 'QA Calgary',
    lat: 51.0447,
    lon: -114.0719,
    zone: 'pnr',
    aqhi: 4,
  },
  {
    id: 'qa-aqhi-yyz',
    name: 'QA Toronto',
    lat: 43.6532,
    lon: -79.3832,
    zone: 'ont',
    aqhi: 6.6,
  },
  {
    id: 'qa-aqhi-yul',
    name: 'QA Montreal',
    lat: 45.5019,
    lon: -73.5674,
    zone: 'que',
    aqhi: 11,
  },
  {
    id: 'qa-aqhi-yhz',
    name: 'QA Halifax',
    lat: 44.6488,
    lon: -63.5752,
    zone: 'atl',
    aqhi: 3,
  },
]);
const aqhiFeature = (station) => ({
  type: 'Feature',
  id: station.id,
  geometry: { type: 'Point', coordinates: [station.lon, station.lat] },
});
const aqhiStations = {
  type: 'FeatureCollection',
  features: aqhiFixtureStations.map((station) => ({
    ...aqhiFeature(station),
    properties: {
      location_id: station.id,
      location_name_en: station.name,
      'eccc_administrative-zone': station.zone,
    },
  })),
};
const aqhiObservations = {
  type: 'FeatureCollection',
  features: aqhiFixtureStations.map((station) => ({
    ...aqhiFeature(station),
    properties: {
      location_id: station.id,
      aqhi: station.aqhi,
      observation_datetime: iso(roundHour(Date.now())),
      special_notes_en: '',
    },
  })),
};

const earthFeatures = (count, depth = 10) =>
  Array.from({ length: count }, (_, index) => {
    const lon = AUSTIN.lon + index * 0.2;
    const lat = AUSTIN.lat + index * 0.2;
    return {
      type: 'Feature',
      id: `qa-quake-${index + 1}`,
      properties: {
        mag: 3.2 + index * 0.3,
        place: `QA ${index + 1}`,
        time: Date.now() - HOUR - index * 60_000,
        updated: Date.now(),
        url: 'https://example.test/qa-quake',
        status: 'reviewed',
        tsunami: 0,
        sig: 100 + index,
      },
      geometry: { type: 'Point', coordinates: [lon, lat, depth] },
    };
  });

const emscFeatures = (count, depth = 10) =>
  Array.from({ length: count }, (_, index) => {
    const lon = AUSTIN.lon + 0.1 + index * 0.2;
    const lat = AUSTIN.lat + 0.1 + index * 0.2;
    return {
      type: 'Feature',
      id: `qa-emsc-${index + 1}`,
      properties: {
        unid: `qa-emsc-${index + 1}`,
        mag: 2.8 + index * 0.3,
        time: iso(Date.now() - HOUR - index * 60_000).replace('.000Z', 'Z'),
        flynn_region: `QA EMSC ${index + 1}`,
        lat,
        lon,
        depth,
      },
      geometry: { type: 'Point', coordinates: [lon, lat, -depth] },
    };
  });

const overpassElements = (tags, count = 4) =>
  Array.from({ length: count }, (_, index) => ({
    type: 'node',
    id: 900000 + index,
    lat: AUSTIN.lat + index * 0.01,
    lon: AUSTIN.lon + index * 0.01,
    tags,
  }));

const points = (source, count = 4) =>
  Array.from({ length: count }, (_, index) => ({
    id: `qa-${source}-${index + 1}`,
    lat: AUSTIN.lat + index * 0.01,
    lon: AUSTIN.lon + index * 0.01,
    label: `QA ${source} ${index + 1}`,
    meta: {
      status: index % 2 ? 'up' : 'down',
      latencyMs: 10 + index,
      host: 'qa.test',
    },
  }));

const cctvSources = {
  ...recordedCctv,
  sources: recordedCctv.sources.map((source, index) => ({
    ...source,
    id: `qa-cctv-${index + 1}`,
    name: `QA CCTV ${index + 1}`,
    lat: AUSTIN.lat + index * 0.01,
    lon: AUSTIN.lon + index * 0.01,
    city: 'Austin',
    cityId: 'austin',
  })),
};

const fixtures = {
  flights: {
    match: (url) => url.pathname === '/api/flights',
    respond: () =>
      json({ ...recordedFlights, time: Math.floor(Date.now() / 1000) }),
  },
  adsbdb: {
    match: (url) => url.pathname.startsWith('/api/adsbdb/'),
    // Ambient type and route enrichment is best-effort. A negative answer
    // covers every contact in the recorded fleet without inventing metadata.
    respond: () => json({ found: false }),
  },
  military: {
    match: (url) => url.pathname === '/api/military',
    respond: () => json(recordedMilitary),
  },
  earthquakes: {
    match: (url) => url.hostname === 'earthquake.usgs.gov',
    respond: () =>
      json({
        type: 'FeatureCollection',
        metadata: { generated: Date.now() },
        features: earthFeatures(4),
      }),
  },
  emsc: {
    match: (url) => url.hostname === 'www.seismicportal.eu',
    respond: () =>
      json({ type: 'FeatureCollection', features: emscFeatures(4) }),
  },
  conflicts: {
    match: (url) => url.pathname === '/api/conflicts',
    respond: () =>
      json({
        ok: true,
        provider: 'acled',
        error: null,
        data: acledRows,
        generatedAt: Date.now(),
      }),
  },
  insider: {
    match: (url) => url.pathname === '/api/insider',
    respond: () =>
      json({
        ok: true,
        error: null,
        generatedAt: Date.now(),
        updatedAt: Date.now(),
        rows: Array.from({ length: 4 }, (_, index) => ({
          id: `qa-accession-${index + 1}`,
          formType: '4',
          company: `QA Company ${index + 1}`,
          insider: `QA Insider ${index + 1}`,
          issuerCik: '0000000001',
          insiderCik: '0000000002',
          filedAt: Date.now() - index * 60_000,
          filedDay: iso(Date.now()).slice(0, 10),
          filingUrl: 'https://www.sec.gov/Archives/qa',
        })),
      }),
  },
  radiation: {
    match: (url) => url.pathname === '/api/radiation',
    respond: () => json({ ...recordedRadiation, fetchedAt: Date.now() }),
  },
  'space-weather': {
    match: (url) => url.pathname === '/api/space-weather',
    respond: () => json({ ...recordedSpaceWeather, fetchedAt: Date.now() }),
  },
  gnss: {
    match: (url) => url.pathname === '/api/gnss-integrity',
    respond: () =>
      json({ ...recordedGnss, fetchedAt: Date.now(), ageMs: 1000 }),
  },
  launches: {
    match: (url) => url.pathname === '/api/launches',
    respond: () => {
      const net = iso(Date.now() - 2 * HOUR);
      return json({
        count: 2,
        next: null,
        previous: null,
        results: Array.from({ length: 2 }, (_, index) => ({
          id: `qa-launch-${index + 1}`,
          name: `QA Launch ${index + 1}`,
          net,
          status: { name: 'Launch Successful' },
          pad: { name: 'QA Pad', latitude: AUSTIN.lat, longitude: AUSTIN.lon },
          launch_service_provider: { name: 'QA Launch Provider' },
          mission: {
            name: `QA Mission ${index + 1}`,
            description: 'Deterministic QA payload',
            orbit: { name: 'Low Earth Orbit' },
          },
        })),
      });
    },
  },
  tle: {
    match: (url) => url.pathname.startsWith('/api/celestrak/'),
    respond: () => text(tleText),
  },
  'tle-catalogue': {
    match: (url) => url.pathname.startsWith('/api/tle-catalogue/'),
    respond: (url) => {
      const page = Number(url.pathname.split('/').at(-1)) || 1;
      const pageSize = 2;
      const member = tleMembers.slice((page - 1) * pageSize, page * pageSize);
      return json({ ...recordedTle, member, totalItems: tleMembers.length });
    },
  },
  'tle-catnr': {
    match: (url) => url.pathname.startsWith('/api/celestrak/catnr/'),
    respond: (url) => text(tleFor(url.pathname.split('/').at(-1))),
  },
  'n2yo-above': {
    match: (url) => url.pathname === '/api/n2yo/above',
    respond: () => json({ above: [] }),
  },
  spacetrack: {
    match: (url) => url.pathname.startsWith('/api/spacetrack/'),
    respond: () => json({ data: [] }),
  },
  radio: {
    match: (url) => url.pathname === '/api/radio/stations',
    respond: () =>
      json({ ...recordedRadio, updatedAt: new Date().toISOString() }),
  },
  'transit-feeds': {
    match: (url) => url.pathname === '/api/transit/feeds',
    respond: () => json({ feeds: [transitFeed] }),
  },
  'transit-vehicles': {
    match: (url) => url.pathname.startsWith('/api/transit/vehicles/'),
    respond: () => json({ ...transitVehicles, fetchedAt: Date.now() }),
  },
  gbfs: {
    match: (url) => url.pathname.startsWith('/api/gbfs/'),
    respond: () =>
      json({
        data: {
          stations: Array.from({ length: 4 }, (_, index) => ({
            station_id: `qa-bike-${index + 1}`,
            name: `QA Bike ${index + 1}`,
            lat: AUSTIN.lat + index * 0.01,
            lon: AUSTIN.lon + index * 0.01,
            capacity: 12,
            num_bikes_available: 5,
            num_docks_available: 7,
            is_installed: 1,
            is_renting: 1,
            is_returning: 1,
          })),
        },
      }),
  },
  cctv: {
    match: (url) =>
      url.pathname === '/api/cctv/sources' ||
      url.pathname === '/api/cctv/health',
    respond: (url) =>
      json(url.pathname.endsWith('/health') ? { cameras: [] } : cctvSources),
  },
  'cctv-frame': {
    match: (url) => url.pathname.startsWith('/api/cctv/frame/'),
    respond: () => png(),
  },
  'fire-perimeters': {
    match: (url) => url.pathname === '/api/fire-perimeters',
    respond: () => json({ ...recordedFires, fetchedAt: Date.now() }),
  },
  ghostmaps: {
    match: (url) => url.pathname === '/api/ghostmaps/catalog',
    respond: () =>
      json({
        ...recordedGhostmaps,
        checkedAt: Date.now(),
        changedAt: Date.now(),
        error: null,
      }),
  },
  'ghostmaps-events': {
    match: (url) => url.pathname === '/api/ghostmaps/events',
    respond: () => ({
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      },
      body: 'retry: 60000\n\n',
    }),
  },
  'ghostmaps-file': {
    match: (url) => url.pathname.startsWith('/api/ghostmaps/file/'),
    respond: () =>
      binary(readBuffer('ghostmaps.kmz'), 'application/vnd.google-earth.kmz'),
  },
  firms: {
    match: (url) => url.pathname === '/api/firms',
    respond: () =>
      json({
        fetchedAt: Date.now(),
        stale: false,
        keyRequired: false,
        fires: qaFires,
        sources: [{ source: 'VIIRS', count: qaFires.length, ok: true }],
      }),
  },
  fishing: {
    match: (url) => url.pathname === '/api/fishing-effort',
    respond: () =>
      json({
        cells: qaCells,
        totalHours: qaCells.reduce((sum, cell) => sum + cell.hours, 0),
        cellCount: qaCells.length,
        truncated: false,
      }),
  },
  'cell-towers': {
    match: (url) => url.pathname === '/api/cell-towers',
    respond: () =>
      json({
        points: points('cell'),
        ageMs: 1000,
        stale: false,
        truncated: false,
        source: 'opencellid',
        matched: 4,
        attribution: { label: 'OpenCelliD (CC BY-SA)' },
      }),
  },
  'iot-sensors': {
    match: (url) => url.pathname === '/api/iot/sensors',
    respond: () =>
      json({
        points: points('iot'),
        ageMs: 1000,
        stale: false,
        truncated: false,
        source: 'opensensemap',
        attribution: { label: 'openSenseMap' },
      }),
  },
  netmon: {
    match: (url) => url.pathname === '/api/netmon',
    respond: () =>
      json({
        points: points('netmon', 3),
        ageMs: 1000,
        stale: false,
        truncated: false,
        configured: true,
        totalTargets: 3,
        placedTargets: 3,
      }),
  },
  vessels: {
    match: (url) => url.pathname === '/api/vessels',
    respond: () =>
      json({
        rows: Array.from({ length: 4 }, (_, index) => ({
          mmsi: `3669000${index + 1}`,
          name: `QA Vessel ${index + 1}`,
          lat: 29.3 + index * 0.02,
          lon: -94.7 + index * 0.02,
          sog: 8 + index,
          cog: 90 + index * 10,
          heading: 90 + index * 10,
          type: 'Cargo',
        })),
        source: 'AISStream',
        status: 'live',
        error: null,
        refreshing: false,
        complete: true,
        newestPositionAt: iso(Date.now() - 60_000),
        observedAtMs: Date.now(),
        lastMessageAt: iso(Date.now() - 30_000),
        silentForMs: 30_000,
        staleAfterMs: 900_000,
      }),
  },
  gdacs: {
    match: (url) =>
      url.hostname === 'www.gdacs.org' &&
      url.pathname.includes('/geteventlist/'),
    respond: () => {
      const from = iso(Date.now() - 6 * HOUR).replace('.000Z', '');
      const to = iso(Date.now() - HOUR).replace('.000Z', '');
      return json({
        type: 'FeatureCollection',
        features: [1, 2].map((index) => ({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [AUSTIN.lon + index * 0.1, AUSTIN.lat + index * 0.1],
          },
          properties: {
            eventtype: index === 1 ? 'EQ' : 'FL',
            eventid: 9000 + index,
            episodeid: 1,
            eventname: `QA GDACS ${index}`,
            alertlevel: index === 1 ? 'Orange' : 'Green',
            fromdate: from,
            todate: to,
            country: 'Qalandia',
            url: { report: 'https://example.test/gdacs' },
            severitydata: { severity: index * 4.5, severityunit: 'M' },
          },
        })),
      });
    },
  },
  effis: {
    match: (url) => url.hostname === 'maps.effis.emergency.copernicus.eu',
    respond: () => {
      const firedate = `${iso(Date.now() - 6 * HOUR).slice(0, 10)} 06:00:00`;
      const lon = AUSTIN.lon - 0.4;
      const lat = AUSTIN.lat - 0.4;
      return json({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [lon, lat],
                  [lon + 0.1, lat],
                  [lon + 0.1, lat + 0.1],
                  [lon, lat + 0.1],
                  [lon, lat],
                ],
              ],
            },
            properties: {
              id: 'qa-effis-1',
              FIREDATE: firedate,
              AREA_HA: '120',
              COUNTRY: 'Qalandia',
              PROVINCE: 'QA',
              COMMUNE: 'QA',
            },
          },
        ],
      });
    },
  },
  copernicus: {
    match: (url) => url.pathname === '/api/copernicus-ems',
    respond: () => {
      const activationTime = iso(Date.now() - 3 * HOUR).replace('.000Z', '');
      return json({
        results: [
          {
            code: 'EMSR-QA1',
            name: 'QA Copernicus activation',
            activationTime,
            centroid: `POINT (${AUSTIN.lon + 0.2} ${AUSTIN.lat + 0.2})`,
            category: { slug: 'flood' },
            countries: ['Qalandia'],
            closed: false,
            reportLink: 'https://example.test/ems',
          },
        ],
      });
    },
  },
  'air-quality': {
    match: (url) => url.hostname === 'api.weather.gc.ca',
    respond: (url) =>
      json(
        url.pathname.includes('aqhi-stations')
          ? aqhiStations
          : aqhiObservations,
      ),
  },
  'military-installations': {
    match: (url) => url.pathname === '/api/military-installations',
    respond: () =>
      json({
        elements: overpassElements({
          military: 'airfield',
          name: 'QA Airfield',
        }),
        retrievedAt: iso(),
        status: 'ok',
      }),
  },
  'google-places': {
    match: (url) =>
      url.pathname === '/api/google/text-search' ||
      url.pathname === '/api/google/nearby-places',
    respond: () => json({ places: [] }),
  },
  overpass: {
    match: (url) =>
      url.pathname === '/api/overpass' ||
      url.pathname === '/api/overpass/status',
    respond: (url) =>
      url.pathname.endsWith('/status')
        ? json({ configured: true })
        : json({
            elements: overpassElements(
              {
                railway: 'station',
                station: 'train',
                name: 'QA Station',
                place: 'city',
                amenity: 'cafe',
              },
              6,
            ),
          }),
  },
  'rail-departures': {
    match: (url) => url.pathname === '/api/rail/departures',
    respond: () =>
      json({
        departures: Array.from({ length: 3 }, (_, index) => ({
          id: `qa-departure-${index + 1}`,
          line: `QA ${index + 1}`,
          destination: 'QA Destination',
          expected: iso(Date.now() + (index + 1) * 10 * 60_000),
          platform: '1',
        })),
      }),
  },
  'camera-advisories': {
    match: (url) => url.pathname === '/api/camera-advisories',
    respond: () =>
      json({
        generatedAt: iso(),
        findings: Array.from({ length: 4 }, (_, index) => ({
          id: `qa-camera-${index + 1}`,
          name: `QA Camera ${index + 1}`,
          lat: AUSTIN.lat + index * 0.01,
          lon: AUSTIN.lon + index * 0.01,
          brand: 'QA',
          model: 'QA-1',
          matches: [
            {
              source: 'cisa',
              id: `ICSA-26-${String(index + 1).padStart(3, '0')}`,
              title: 'QA camera advisory',
              url: 'https://example.test/advisory',
              severity: 'high',
              score: 9.8,
              cves: ['CVE-2026-0001'],
              match: 'model',
            },
          ],
        })),
        counts: { critical: 0, high: 4, medium: 0, low: 0, unscored: 0 },
      }),
  },
  'weather-manifest': {
    match: (url) => url.pathname === '/api/weather/manifest',
    respond: (url) => {
      const product = url.searchParams.get('product') || 'radar';
      return json(weatherManifest(product));
    },
  },
  'weather-image': {
    match: (url) =>
      url.pathname === '/api/weather/image' ||
      url.pathname === '/api/weather/tile',
    respond: () => png(),
  },
  wind: {
    match: (url) => url.pathname === '/api/wind/manifest',
    respond: () =>
      json({
        ...recordedWind,
        fetchedAt: Date.now(),
        overlay: 'none',
        gridUrl: '/api/wind/grid/gfs-qa-f9-1.bin?model=gfs',
      }),
  },
  'wind-grid': {
    match: (url) => url.pathname.startsWith('/api/wind/grid/'),
    respond: () => binary(windGrid),
  },
  cyclones: {
    match: (url) => url.pathname === '/api/cyclones',
    respond: () =>
      json({
        schemaVersion: 1,
        source: 'NOAA NHC / CPHC',
        attribution:
          'NOAA/NWS National Hurricane Center / Central Pacific Hurricane Center',
        coverage: 'Atlantic and eastern/central North Pacific',
        fetchedAt: Date.now(),
        stale: false,
        unavailable: false,
        reason: null,
        storms: [cycloneStorm],
      }),
  },
  'google-tiles-token': {
    match: (url) => url.pathname === '/api/google/tiles-token',
    // A keyless server offers no Google token; the client treats this as the
    // supported capability miss and carries on without one.
    respond: () => json({}),
  },
  'realtime-debug-log': {
    match: (url) => url.pathname === '/api/realtime/debug-log',
    // Voice diagnostics fire-and-forget their records; accept them without
    // writing to the repository's .gev-logs directory.
    respond: () => ({ status: 204, headers: {}, body: null }),
  },
  traffic: {
    match: (url) =>
      url.pathname.startsWith('/api/tomtom/') ||
      url.hostname === 'tiles.openfreemap.org',
    respond: (_url, source) => trafficFixtureResponse(source),
  },
};

/** Every fixture id the matrix may reference from the coverage manifest. */
export const FIXTURE_IDS = Object.freeze(Object.keys(fixtures).sort());

/**
 * App-session fixtures no single layer owns. They answer requests made during
 * boot and diagnostics, so the coverage manifest does not reference them.
 */
export const GLOBAL_FIXTURE_IDS = Object.freeze([
  'google-tiles-token',
  'realtime-debug-log',
]);

/**
 * Return one named fixture's response for a URL without going through the
 * router's first-match order. The schema-drift check uses this to sample
 * fixtures that share a path prefix (for example tle and tle-catnr).
 * @param {string} id fixture id
 * @param {string} rawUrl absolute request URL
 * @returns {object} fixture response
 */
export function fixtureResponse(id, rawUrl) {
  const fixture = fixtures[id];
  if (!fixture) throw new Error(`unknown fixture ${id}`);
  const url = new URL(rawUrl);
  if (!fixture.match(url)) {
    throw new Error(`fixture ${id} does not match ${rawUrl}`);
  }
  return fixture.respond(url, { url: () => rawUrl });
}

/**
 * Find the first fixture that answers a request URL.
 * @param {string} rawUrl absolute request URL
 * @returns {{id:string, response:object}|null}
 */
export function fixtureFor(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  for (const [id, fixture] of Object.entries(fixtures)) {
    if (!fixture.match(url)) continue;
    try {
      const response = fixture.respond(url, { url: () => rawUrl });
      if (response) return { id, response };
    } catch (error) {
      return {
        id,
        response: json(
          { error: `fixture ${id} failed: ${error.message}` },
          500,
        ),
      };
    }
  }
  return null;
}

/** Coordinates where the recorded synthetic payloads are placed. */
export { AUSTIN as FIXTURE_ANCHOR };
