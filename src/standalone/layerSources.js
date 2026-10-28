import { createDirectionsSource } from '../layers/directions/source.js';
import { createRecentImagerySource } from '../layers/recentImagery/source.js';
import { createOpenFreeMapSource } from '../sources/openFreeMap.js';
import {
  createFlightSource,
  createMilitarySource,
  createVesselSource,
} from '../sources/live/standalone.js';
import { createCctvSource } from '../layers/cctv/source.js';
import { createRadioSource } from '../layers/radio/source.js';
import { createTransitSource } from '../layers/transit/source.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import { createBikeshareSource } from '../layers/bikeshare/source.js';
import { createInstallationSource } from '../layers/installations/source.js';
import { createSatelliteSource } from '../layers/satellites/source.js';
import { createLaunchSource } from '../layers/launches/source.js';
import { createAlprTileSource } from '../layers/alpr/source.js';
import { createWeatherSource } from '../layers/weather/source.js';
import { createCycloneSource } from '../layers/cyclones/source.js';
import { createWindSource } from '../layers/wind/source.js';
import { createFirmsSource } from '../layers/firms/source.js';
import {
  createWindySource,
  FALLBACK_WINDY_KEY,
} from '../layers/windy/source.js';
import { createGhostMapsSource } from '../layers/ghostMaps/source.js';
import { createMapillarySource } from '../layers/streetLevel/providers/mapillary/source.js';
import { createReferenceSources } from '../sources/reference.js';
import { getApiKey } from '../data/storedApiKeys.js';
export { createReferenceSources as createStandaloneReferenceSources } from '../sources/reference.js';

/**
 * The asset origin the APK serves its bundle from (mirrors `inAppApi.js`).
 *
 * Kept local because this module is a package entry of its own: importing the
 * in-app API would pull every route it answers into this boundary.
 */
const SHELL_HOST = 'appassets.androidplatform.net';

/**
 * The tile reads the shell cannot make for itself.
 *
 * OpenFreeMap publishes the street geometry behind the traffic and
 * mapped-installation layers as immutable planet tiles. From the asset origin
 * those reads are cross-origin, and on the phone they did not fail fast: a tile
 * request hung for tens of seconds, past the road pass deadline, so the layer
 * drew no roads at all. The shell's relay fetches the bytes instead, from a
 * server that reaches OpenFreeMap normally. The URL is allow-listed there by
 * origin and tile shape, never by a wildcard; the same shapes are pinned here so
 * a read that the relay would refuse is not turned into a refused call.
 */
const RELAYED_TILE_ORIGINS = Object.freeze(['https://tiles.openfreemap.org']);
const RELAYED_TILE_PATHS = Object.freeze([
  /^\/planet$/,
  /^\/planet\/[0-9A-Za-z_]+\/\d{1,5}\/\d{1,5}\/\d{1,5}\.pbf$/,
]);

/**
 * The relay URL for a tile read the shell cannot make itself.
 *
 * @param {unknown} raw - The upstream URL, absolute.
 * @param {?Location} [location]
 * @returns {?string} `/api/upstream?url=…`, or `null` when the read stands.
 */
export function relayedTileUrl(raw, location = globalThis.location) {
  if (location?.hostname !== SHELL_HOST || typeof raw !== 'string') return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!RELAYED_TILE_ORIGINS.includes(url.origin)) return null;
  if (!RELAYED_TILE_PATHS.some((shape) => shape.test(url.pathname)))
    return null;
  return `/api/upstream?url=${encodeURIComponent(url.href)}`;
}

/**
 * Wrap `fetch` so tile reads go through the shell's relay and everything else
 * is untouched. Outside the shell this is the identity, so the same build keeps
 * fetching tiles directly.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {?Location} [options.location]
 * @returns {typeof fetch}
 */
export function relayedTileFetch({
  fetchImpl = (...args) => globalThis.fetch(...args),
  location = globalThis.location,
} = {}) {
  return (input, init) => {
    const raw = typeof input === 'string' ? input : input?.url;
    const relayed = relayedTileUrl(raw, location);
    return fetchImpl(relayed ?? input, init);
  };
}

/** Select standalone providers without starting their acquisition. */
export function createStandaloneLayerSources(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))
    throw new TypeError('Source overrides must be an object');
  // Street geometry is the one cross-origin read the APK cannot make for
  // itself; outside the shell the wrapper is the identity.
  const mapTiles = createOpenFreeMapSource({
    fetchImpl: relayedTileFetch(),
  });
  const defaults = {
    ...createReferenceSources(),
    directions: createDirectionsSource(),
    'recent-imagery': createRecentImagerySource(),
    flights: createFlightSource(),
    military: createMilitarySource(),
    vessels: createVesselSource({
      apiUrl: import.meta.env?.VITE_AIS_LIVE_API_URL || '/api/vessels',
      // Resolved against the document's address, which a panel host may
      // serve from its own scheme.
      origin: () => globalThis.document?.baseURI ?? 'http://localhost',
    }),
    cctv: createCctvSource(),
    radio: createRadioSource(),
    traffic: createTrafficSource({ mapTiles }),
    transit: createTransitSource(),
    bikeshare: createBikeshareSource(),
    installations: createInstallationSource({ mapTiles }),
    satellites: createSatelliteSource(),
    launches: createLaunchSource(),
    alpr: createAlprTileSource(),
    firms: createFirmsSource(),
    's2-ghostmaps': createGhostMapsSource(),
    wind: createWindSource(),
    weather: createWeatherSource(),
    cyclones: createCycloneSource(),
    'windy-weather': createWindySource({
      // Resolved here because a portable source cannot read Provider Settings.
      apiKey: getApiKey('WINDY_API_KEY', FALLBACK_WINDY_KEY),
    }),
    mapillary: createMapillarySource({
      token: import.meta.env?.MAPILLARY_CLIENT_TOKEN || '',
    }),
  };
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(defaults, name))
      throw new TypeError(`Unknown source: ${name}`);
  }
  return { ...defaults, ...overrides };
}
