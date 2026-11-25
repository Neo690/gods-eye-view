/**
 * Provider-schema drift probes for the layer-activation fixtures.
 *
 * The matrix sends synthetic provider payloads through the real layer code. A
 * fixture can keep those tests green even after a provider renames or removes a
 * field, because the matrix only checks the layer's derived data contract. These
 * probes pin the structure of every JSON fixture instead: object keys and value
 * types are fingerprinted, while changing values or timestamps are ignored.
 *
 * When a provider schema changes, update the fixture and the snapshot together
 * with `npm run qa:fixture-drift -- --write`. The review then shows both the
 * fixture edit and the deliberate schema change.
 *
 * Binary and line-oriented payloads cannot be represented as a JSON schema and
 * are listed in FIXTURE_SCHEMA_EXEMPTIONS. The matrix test requires every
 * fixture to be either probed or exempt, so a new fixture cannot silently avoid
 * drift coverage.
 */
import { createHash } from 'node:crypto';
import { FIXTURE_IDS, fixtureResponse } from './network.mjs';

/** One or more JSON samples for each schema-bearing fixture. */
export const FIXTURE_SCHEMA_PROBES = Object.freeze({
  flights: [{ variant: 'default', url: 'http://127.0.0.1/api/flights' }],
  adsbdb: [{ variant: 'default', url: 'http://127.0.0.1/api/adsbdb/qa' }],
  military: [{ variant: 'default', url: 'http://127.0.0.1/api/military' }],
  earthquakes: [
    {
      variant: 'default',
      url: 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson',
    },
  ],
  emsc: [
    {
      variant: 'default',
      url: 'https://www.seismicportal.eu/fdsnws/event/1/query?format=json',
    },
  ],
  conflicts: [{ variant: 'default', url: 'http://127.0.0.1/api/conflicts' }],
  insider: [{ variant: 'default', url: 'http://127.0.0.1/api/insider' }],
  radiation: [{ variant: 'default', url: 'http://127.0.0.1/api/radiation' }],
  'space-weather': [
    { variant: 'default', url: 'http://127.0.0.1/api/space-weather' },
  ],
  gnss: [{ variant: 'default', url: 'http://127.0.0.1/api/gnss-integrity' }],
  launches: [{ variant: 'default', url: 'http://127.0.0.1/api/launches' }],
  'tle-catalogue': [
    { variant: 'default', url: 'http://127.0.0.1/api/tle-catalogue/1' },
  ],
  'n2yo-above': [
    { variant: 'default', url: 'http://127.0.0.1/api/n2yo/above' },
  ],
  spacetrack: [
    { variant: 'default', url: 'http://127.0.0.1/api/spacetrack/query' },
  ],
  radio: [{ variant: 'default', url: 'http://127.0.0.1/api/radio/stations' }],
  'transit-feeds': [
    { variant: 'default', url: 'http://127.0.0.1/api/transit/feeds' },
  ],
  'transit-vehicles': [
    {
      variant: 'default',
      url: 'http://127.0.0.1/api/transit/vehicles/qa-transit',
    },
  ],
  gbfs: [{ variant: 'default', url: 'http://127.0.0.1/api/gbfs/qa' }],
  cctv: [
    { variant: 'sources', url: 'http://127.0.0.1/api/cctv/sources' },
    { variant: 'health', url: 'http://127.0.0.1/api/cctv/health' },
  ],
  'fire-perimeters': [
    { variant: 'default', url: 'http://127.0.0.1/api/fire-perimeters' },
  ],
  ghostmaps: [
    { variant: 'default', url: 'http://127.0.0.1/api/ghostmaps/catalog' },
  ],
  firms: [{ variant: 'default', url: 'http://127.0.0.1/api/firms' }],
  fishing: [{ variant: 'default', url: 'http://127.0.0.1/api/fishing-effort' }],
  'cell-towers': [
    { variant: 'default', url: 'http://127.0.0.1/api/cell-towers' },
  ],
  'iot-sensors': [
    { variant: 'default', url: 'http://127.0.0.1/api/iot/sensors' },
  ],
  netmon: [{ variant: 'default', url: 'http://127.0.0.1/api/netmon' }],
  vessels: [{ variant: 'default', url: 'http://127.0.0.1/api/vessels' }],
  gdacs: [{ variant: 'default', url: 'https://www.gdacs.org/x/geteventlist/' }],
  effis: [
    {
      variant: 'default',
      url: 'https://maps.effis.emergency.copernicus.eu/x',
    },
  ],
  copernicus: [
    { variant: 'default', url: 'http://127.0.0.1/api/copernicus-ems' },
  ],
  'air-quality': [
    {
      variant: 'stations',
      url: 'https://api.weather.gc.ca/collections/aqhi-stations/items',
    },
    {
      variant: 'observations',
      url: 'https://api.weather.gc.ca/collections/aqhi-observations/items',
    },
  ],
  'military-installations': [
    {
      variant: 'default',
      url: 'http://127.0.0.1/api/military-installations',
    },
  ],
  'google-places': [
    { variant: 'text-search', url: 'http://127.0.0.1/api/google/text-search' },
  ],
  overpass: [
    { variant: 'data', url: 'http://127.0.0.1/api/overpass' },
    { variant: 'status', url: 'http://127.0.0.1/api/overpass/status' },
  ],
  'rail-departures': [
    { variant: 'default', url: 'http://127.0.0.1/api/rail/departures' },
  ],
  'camera-advisories': [
    { variant: 'default', url: 'http://127.0.0.1/api/camera-advisories' },
  ],
  'weather-manifest': [
    {
      variant: 'radar',
      url: 'http://127.0.0.1/api/weather/manifest?product=radar',
    },
  ],
  wind: [{ variant: 'default', url: 'http://127.0.0.1/api/wind/manifest' }],
  cyclones: [{ variant: 'default', url: 'http://127.0.0.1/api/cyclones' }],
  'google-tiles-token': [
    { variant: 'capability', url: 'http://127.0.0.1/api/google/tiles-token' },
  ],
  traffic: [
    { variant: 'status', url: 'http://127.0.0.1/api/tomtom/status' },
    { variant: 'planet', url: 'https://tiles.openfreemap.org/planet' },
  ],
});

/**
 * Fixtures whose payload is not JSON, or has no schema to pin.
 *
 * These are intentionally explicit: adding a fixture without deciding whether
 * it needs a schema probe fails the matrix test.
 */
export const FIXTURE_SCHEMA_EXEMPTIONS = Object.freeze({
  tle: 'CelesTrak TLE is newline-oriented text; its parser contract is not JSON.',
  'tle-catnr':
    'CelesTrak catnr output is the same line-oriented TLE text format.',
  'cctv-frame': 'Camera frames are PNG bytes, not a JSON schema.',
  'ghostmaps-events':
    'The events fixture is an SSE keepalive with no JSON body.',
  'ghostmaps-file': 'The GhostMaps file fixture is a KMZ archive.',
  'weather-image': 'Weather image tiles are PNG bytes.',
  'wind-grid': 'The wind grid fixture is a binary payload.',
  'realtime-debug-log': 'The debug-log fixture is a 204 with no body.',
});

/** Fixture ids represented by at least one schema probe. */
export const PROBED_FIXTURE_IDS = Object.freeze(
  Object.keys(FIXTURE_SCHEMA_PROBES).sort(),
);

/** Recursive type tree. Values are discarded; keys, types and array unions stay. */
export function schemaShape(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const children = [...new Set(value.map(schemaShape))].sort();
    return `array(${children.join('|')})`;
  }
  if (typeof value === 'object') {
    return `object(${Object.keys(value)
      .sort()
      .map((key) => `${key}:${schemaShape(value[key])}`)
      .join(',')})`;
  }
  return typeof value;
}

function sampleBody(fixtureId, probe) {
  const response = fixtureResponse(fixtureId, probe.url);
  if (!response) {
    throw new Error(
      `fixture ${fixtureId} returned no response for ${probe.url}`,
    );
  }
  const contentType = String(
    response.contentType ?? response.headers?.['content-type'] ?? '',
  );
  if (!contentType.includes('json')) {
    throw new Error(
      `fixture ${fixtureId}#${probe.variant} is not JSON (${contentType || 'unknown content type'})`,
    );
  }
  return JSON.parse(String(response.body));
}

/** Stable, sorted samples including the human-readable shape and fingerprint. */
export function fixtureSchemaSamples() {
  const samples = [];
  for (const [fixtureId, probes] of Object.entries(FIXTURE_SCHEMA_PROBES)) {
    for (const probe of probes) {
      const shape = schemaShape(sampleBody(fixtureId, probe));
      samples.push({
        key: `${fixtureId}#${probe.variant}`,
        fixtureId,
        variant: probe.variant,
        shape,
        fingerprint: createHash('sha256').update(shape).digest('hex'),
      });
    }
  }
  return samples.sort((left, right) => left.key.localeCompare(right.key));
}

/** Fingerprints keyed by fixture and variant, suitable for the snapshot file. */
export function fixtureSchemaFingerprints(samples = fixtureSchemaSamples()) {
  return Object.fromEntries(
    samples.map(({ key, fingerprint }) => [key, fingerprint]),
  );
}

/** Keys whose expected and actual fingerprints differ, including added/removed. */
export function fixtureSchemaDrift(expected, actual) {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...keys]
    .filter((key) => expected[key] !== actual[key])
    .sort((left, right) => left.localeCompare(right));
}

/** Guard used by tests: every fixture must be probed or explicitly exempt. */
export function fixtureSchemaCoverageErrors() {
  const probed = new Set(PROBED_FIXTURE_IDS);
  const exempt = new Set(Object.keys(FIXTURE_SCHEMA_EXEMPTIONS));
  const errors = [];
  for (const id of FIXTURE_IDS) {
    if (!probed.has(id) && !exempt.has(id)) {
      errors.push(`${id} is neither schema-probed nor explicitly exempt`);
    }
    if (probed.has(id) && exempt.has(id)) {
      errors.push(`${id} is both schema-probed and exempt`);
    }
  }
  return errors;
}
