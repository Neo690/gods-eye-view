/**
 * live-layer-manifests.mjs — the live canary's layer lists.
 *
 * These are the only inputs a dispatch filter needs, so they live in a module
 * that imports nothing but data. The workflow resolves `layers` before it
 * installs dependencies and before it can key the canary's concurrency group on
 * the result; importing the gate runner here would drag in Puppeteer and make
 * that resolution require `npm ci` first.
 *
 * qa-keyless-live-layers.mjs re-exports both lists, so the runner, the keyed
 * workflow generator and the tests keep one source of truth.
 */

/**
 * The gate's contract. These 15 layers were the temporary live pass; keeping
 * them in one list makes the policy for each upstream reviewable. The list is
 * an execution policy, not the inventory: validateKeylessInventory() derives
 * the full keyless candidate set from the layers' key declarations and
 * requires every candidate to have an include or exclude decision in
 * KEYLESS_CANARY_DECISIONS, which stays with the runner.
 *
 * - expect.min is the number of rows a healthy keyless source provides.
 * - externalFailure says an outage of that provider is a classified EXTERNAL
 *   outcome, not an app failure. apiPrefix scopes the evidence to the app route
 *   that proxies that provider.
 * - allowEmpty says a zero-row feed is legitimate only when the layer marks
 *   stats[statsFlag] true (it distinguishes "no storms" from "failed").
 * - unconfigured says the layer is opt-in, and names the capability probe that
 *   must confirm the omission before the outcome is accepted.
 */
export const KEYED_LAYERS = [
  {
    id: 'local-firms',
    provider: 'NASA FIRMS',
    keyId: 'firms',
    env: ['FIRMS_MAP_KEY'],
    expect: { min: 1 },
    timeoutMs: 90_000,
    externalFailure: {
      apiPrefix: '/api/firms',
      reason:
        'NASA FIRMS can rate-limit or time out; /api/firms serves its stale cache instead of returning a fresh failure.',
    },
  },
  {
    id: 'conflict-events',
    provider: 'ACLED',
    keyId: 'acled',
    env: ['ACLED_EMAIL', 'ACLED_PASSWORD'],
    expect: { min: 1 },
    timeoutMs: 90_000,
    externalFailure: {
      apiPrefix: '/api/conflicts',
      reason:
        'ACLED can fail upstream while the proxy is healthy; the layer then has no fresh conflict snapshot.',
    },
  },
  {
    id: 'fishing-effort',
    provider: 'Global Fishing Watch',
    keyId: 'global-fishing-watch',
    env: ['GFW_API_TOKEN'],
    expect: { min: 1 },
    timeoutMs: 90_000,
    externalFailure: {
      apiPrefix: '/api/fishing-effort',
      reason:
        'Global Fishing Watch can rate-limit or time out independently of the app proxy.',
    },
  },
  {
    id: 'traffic',
    provider: 'TomTom',
    keyId: 'tomtom',
    env: ['TOMTOM_API_KEY'],
    // The layer can always draw simulated traffic; only the live mode proves
    // the credential reached the server-side proxy.
    expect: { min: 1, mode: 'live' },
    view: { lat: 30.2672, lon: -97.7431, alt: 2500 },
    timeoutMs: 90_000,
    externalFailure: {
      apiPrefix: '/api/tomtom',
      reason:
        'TomTom can rate-limit or time out; the tile proxy then has no live flow to prove the key against.',
    },
  },
  {
    id: 'ais-live-vessels',
    provider: 'AISStream',
    keyId: 'aisstream',
    env: ['AISSTREAM_API_KEY'],
    // AISStream needs a key even to open the socket, so this layer has no
    // keyless fallback to prove the credential against. Rows only arrive when
    // the upstream feed is healthy and actually delivering positions.
    expect: { min: 1 },
    timeoutMs: 90_000,
    externalFailure: {
      apiPrefix: '/api/vessels',
      reason:
        'AISStream can rate-limit, reject the socket or stop delivering positions independently of the app proxy.',
    },
  },
];

export const KEYLESS_LAYERS = [
  {
    id: 'earthquakes',
    provider: 'USGS',
    expect: { min: 1 },
  },
  {
    id: 'emsc-seismic',
    provider: 'EMSC',
    expect: { min: 1 },
  },
  {
    id: 'global-disasters',
    provider: 'GDACS / EFFIS / Copernicus',
    expect: { min: 1 },
  },
  {
    id: 'satellites',
    provider: 'CelesTrak',
    expect: { min: 1 },
    timeoutMs: 60_000,
    externalFailure: {
      apiPrefix: '/api/celestrak/',
      reason:
        'CelesTrak regularly 502s or times out; the app surfaces "CelesTrak unreachable" and keeps its previous catalog.',
    },
  },
  {
    id: 'space-weather',
    provider: 'NOAA SWPC',
    expect: { min: 1 },
  },
  {
    id: 'weather-radar',
    provider: 'NOAA nowCOAST',
    expect: { min: 1 },
  },
  {
    id: 'weather-satellite',
    provider: 'NOAA nowCOAST',
    expect: { min: 1 },
  },
  {
    id: 'weather-lightning',
    provider: 'NOAA nowCOAST',
    expect: { min: 1 },
  },
  {
    id: 'weather-cyclones',
    provider: 'NOAA NHC / CPHC',
    expect: { min: 1 },
    allowEmpty: {
      statsFlag: 'empty',
      reason:
        'NOAA CurrentStorms.json legitimately reports activeStorms: []; the layer marks stats.empty instead of treating it as an outage.',
    },
  },
  {
    id: 'radio',
    provider: 'Radio Browser',
    expect: { min: 1 },
  },
  {
    id: 'osm-places',
    provider: 'OpenStreetMap / Overpass',
    expect: { min: 1 },
    unconfigured: {
      env: 'OVERPASS_UPSTREAMS',
      statusPath: '/api/overpass/status',
      errorPattern: 'Overpass endpoint not configured',
      reason:
        'The Overpass proxy is opt-in via OVERPASS_UPSTREAMS; with no operator upstream the layer reports unconfigured and skips the query.',
    },
  },
  {
    id: 'flights',
    provider: 'OpenSky / adsb.lol',
    expect: { min: 1 },
  },
  {
    id: 'military',
    provider: 'adsb.lol',
    expect: { min: 1 },
  },
  {
    id: 'fire-perimeters',
    provider: 'NIFC WFIGS',
    expect: { min: 1 },
  },
  {
    id: 'bikeshare',
    provider: 'GBFS',
    expect: { min: 1 },
    timeoutMs: 60_000,
  },
];
