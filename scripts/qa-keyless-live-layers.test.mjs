import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPLICATION_LAYER_METADATA,
  LOCAL_ONLY_LAYER_METADATA,
} from '../src/app/constructCatalog.js';
import { KEY_SETUP_KEYS } from '../src/keySetupCore.mjs';
import {
  LAYER_KEY_DECLARATIONS,
  deriveKeylessLayerIds,
} from '../src/app/layerKeyDeclarations.js';
import {
  KEYED_LAYERS,
  KEYLESS_CANARY_CONTRACT,
  KEYLESS_CANARY_DECISIONS,
  KEYLESS_LAYERS,
  classifyLayerOutcome,
  isCredentialFailure,
  validateKeylessInventory,
  validateKeylessManifest,
} from './qa-keyless-live-layers.mjs';

const catalogIds = new Set(APPLICATION_LAYER_METADATA.map(({ id }) => id));
const localOnlyIds = new Set(LOCAL_ONLY_LAYER_METADATA.map(({ id }) => id));
const keyedEnvById = new Map(
  KEY_SETUP_KEYS.map(({ id, envVars }) => [id, envVars]),
);

const layer = (id) => KEYLESS_LAYERS.find((entry) => entry.id === id);
const snapshot = (overrides = {}) => ({
  exists: true,
  enabled: true,
  lifecycleState: 'enabled',
  stats: { count: 12 },
  statsError: null,
  ...overrides,
});
const classify = (id, state, options = {}) =>
  classifyLayerOutcome({ layer: layer(id), snapshot: state, ...options });

test('the keyless manifest is valid and covers the temporary live set', () => {
  const validation = validateKeylessManifest();
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(KEYLESS_LAYERS.length, 15);
  assert.deepEqual(
    KEYLESS_LAYERS.map((entry) => entry.id),
    [
      'earthquakes',
      'emsc-seismic',
      'global-disasters',
      'satellites',
      'space-weather',
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
      'weather-cyclones',
      'radio',
      'osm-places',
      'flights',
      'military',
      'fire-perimeters',
      'bikeshare',
    ],
  );
});

test('the keyless inventory is derived from key declarations and fully decided', () => {
  const inventory = validateKeylessInventory();
  assert.equal(inventory.ok, true, inventory.errors.join('\n'));
  assert.equal(inventory.keylessIds.length, 50);
  assert.equal(inventory.included, 15);
  assert.equal(inventory.excluded, 35);
  assert.deepEqual(
    inventory.keylessIds,
    deriveKeylessLayerIds(APPLICATION_LAYER_METADATA),
  );

  // Optional credentials keep a keyless fallback, so these stay in the
  // keyless decision inventory.
  for (const id of ['flights', 'military', 'traffic', 'street-level']) {
    assert.ok(inventory.keylessIds.includes(id), `${id} should be keyless`);
  }
  // Layers with no credential-free operating path must never be keyless.
  for (const id of [
    'local-firms',
    'conflict-events',
    'fishing-effort',
    'ais-live-vessels',
  ]) {
    assert.ok(!inventory.keylessIds.includes(id), `${id} should be keyed`);
  }

  const included = Object.entries(KEYLESS_CANARY_DECISIONS)
    .filter(([, entry]) => entry.decision === 'include')
    .map(([id]) => id)
    .sort();
  assert.deepEqual(included, KEYLESS_LAYERS.map((entry) => entry.id).sort());
  for (const entry of Object.values(KEYLESS_CANARY_DECISIONS)) {
    if (entry.decision === 'exclude') assert.ok(entry.reason);
  }
});

test('the keyless canary contract cannot silently shrink', () => {
  assert.equal(KEYLESS_CANARY_CONTRACT.includedMin, 15);
  assert.equal(KEYLESS_CANARY_CONTRACT.excludedMax, 35);

  // Moving a live layer to the exclusion column would leave the canary
  // deliberately smaller, so the contract must fail until the number is
  // changed in the same review.
  const decisions = {
    ...KEYLESS_CANARY_DECISIONS,
    earthquakes: { decision: 'exclude', reason: 'regression test' },
  };
  const manifest = KEYLESS_LAYERS.filter(({ id }) => id !== 'earthquakes');
  const inventory = validateKeylessInventory({ decisions, manifest });
  assert.equal(inventory.ok, false);
  assert.ok(
    inventory.errors.some((error) =>
      error.includes('below the contract floor'),
    ),
    inventory.errors.join('\n'),
  );
  assert.ok(
    inventory.errors.some((error) =>
      error.includes('above the contract ceiling'),
    ),
    inventory.errors.join('\n'),
  );
});

test('a new keyless layer without a canary decision fails closed', () => {
  const layers = [...APPLICATION_LAYER_METADATA, { id: 'new-keyless-layer' }];
  const inventory = validateKeylessInventory({ layers });
  assert.equal(inventory.ok, false);
  assert.ok(
    inventory.errors.some(
      (error) =>
        error.includes('new-keyless-layer') &&
        error.includes('no canary decision'),
    ),
    inventory.errors.join('\n'),
  );
});

test('declaring a required key moves a new layer out of the keyless inventory', () => {
  const layers = [...APPLICATION_LAYER_METADATA, { id: 'new-keyed-layer' }];
  const declarations = {
    ...LAYER_KEY_DECLARATIONS,
    'new-keyed-layer': { keys: ['firms'], required: true },
  };
  const inventory = validateKeylessInventory({ layers, declarations });
  assert.equal(inventory.ok, true, inventory.errors.join('\n'));
  assert.ok(!inventory.keylessIds.includes('new-keyed-layer'));
});

test('a decision for a keyed layer is rejected as stale', () => {
  const decisions = {
    ...KEYLESS_CANARY_DECISIONS,
    'local-firms': { decision: 'exclude', reason: 'stale decision' },
  };
  const inventory = validateKeylessInventory({ decisions });
  assert.equal(inventory.ok, false);
  assert.ok(
    inventory.errors.some((error) =>
      error.includes(
        'local-firms: canary decision exists for a layer that is not keyless',
      ),
    ),
    inventory.errors.join('\n'),
  );
});

test('every keyless live layer exists in the catalog and is not local-only', () => {
  for (const entry of KEYLESS_LAYERS) {
    assert.ok(
      catalogIds.has(entry.id),
      `${entry.id} is in the live canary but not in the application catalog`,
    );
    assert.ok(
      !localOnlyIds.has(entry.id),
      `${entry.id} is local-only and cannot be exercised by the live canary`,
    );
  }
});

test('the keyed manifest names only catalog layers and registry env vars', () => {
  const validation = validateKeylessManifest(KEYED_LAYERS);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.deepEqual(
    KEYED_LAYERS.map((entry) => entry.id),
    ['local-firms', 'conflict-events', 'fishing-effort', 'traffic'],
  );
  for (const entry of KEYED_LAYERS) {
    assert.ok(
      catalogIds.has(entry.id),
      `${entry.id} is in the keyed canary but not in the application catalog`,
    );
    assert.ok(
      !localOnlyIds.has(entry.id),
      `${entry.id} is local-only and cannot be exercised by the keyed canary`,
    );
    assert.deepEqual(
      entry.env,
      keyedEnvById.get(entry.keyId),
      `${entry.id} must use the env vars owned by ${entry.keyId}`,
    );
    assert.ok(
      entry.externalFailure?.apiPrefix,
      `${entry.id} must declare the provider route used to classify an outage`,
    );
  }
});

test('a keyed outage is EXTERNAL but a missing credential is not', () => {
  const firms = KEYED_LAYERS.find(({ id }) => id === 'local-firms');
  assert.ok(firms.externalFailure);

  const outage = classifyLayerOutcome({
    layer: firms,
    snapshot: snapshot({ stats: { count: 0, error: 'FIRMS HTTP 503' } }),
    evidence: [{ status: 503, url: '/api/firms?bbox=world' }],
  });
  assert.equal(outage.status, 'EXTERNAL');

  const missing = classifyLayerOutcome({
    layer: firms,
    snapshot: snapshot({ stats: { count: 0, error: 'KEY REQUIRED' } }),
    evidence: [{ status: 503, url: '/api/firms?bbox=world' }],
  });
  assert.equal(missing.status, 'FAIL');
  assert.match(missing.reason, /credential failure/);

  const noKey = classifyLayerOutcome({
    layer: firms,
    snapshot: snapshot({ stats: { count: 0, error: 'no_key' } }),
    evidence: [{ status: 503, url: '/api/firms?bbox=world' }],
  });
  assert.equal(noKey.status, 'FAIL');
  assert.ok(isCredentialFailure('Conflicts auth'));
  assert.ok(isCredentialFailure('missing-key'));
  assert.ok(!isCredentialFailure('FIRMS HTTP 503'));
});

test('the keyed traffic canary rejects simulated mode and accepts live mode', () => {
  const traffic = KEYED_LAYERS.find((entry) => entry.id === 'traffic');
  const simulated = classifyLayerOutcome({
    layer: traffic,
    snapshot: snapshot({ stats: { count: 12, mode: 'sim' } }),
  });
  assert.equal(simulated.status, 'PENDING');
  assert.match(simulated.reason, /waiting for "live"/);

  const timedOut = classifyLayerOutcome({
    layer: traffic,
    snapshot: snapshot({ stats: { count: 12, mode: 'sim' } }),
    timedOut: true,
  });
  assert.equal(timedOut.status, 'FAIL');
  assert.match(timedOut.reason, /mode is "sim", expected "live"/);

  const live = classifyLayerOutcome({
    layer: traffic,
    snapshot: snapshot({ stats: { count: 12, mode: 'live' } }),
  });
  assert.equal(live.status, 'PASS');
});

test('the manifest rejects a layer without an expectation or provider', () => {
  const broken = structuredClone(KEYLESS_LAYERS);
  delete broken[0].provider;
  broken[1].expect = { min: 0 };
  const validation = validateKeylessManifest(broken);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => error.includes('provider')));
  assert.ok(validation.errors.some((error) => error.includes('expect.min')));
});

test('a live source with rows is a PASS', () => {
  const result = classify('earthquakes', snapshot({ stats: { count: 53 } }));
  assert.equal(result.status, 'PASS');
  assert.equal(result.count, 53);
});

test('a declared empty feed is EMPTY, not FAIL', () => {
  const result = classify(
    'weather-cyclones',
    snapshot({ stats: { count: 0, empty: true, error: null } }),
  );
  assert.equal(result.status, 'EMPTY');
  assert.match(result.reason, /activeStorms/);
});

test('a lifecycle error is not masked by stale rows', () => {
  const result = classify(
    'earthquakes',
    snapshot({ lifecycleState: 'error', stats: { count: 12 } }),
  );
  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /lifecycle is error/);
});

test('an undeclared empty feed stays a FAIL', () => {
  const result = classify('earthquakes', snapshot({ stats: { count: 0 } }));
  assert.equal(result.status, 'PENDING');
  const timedOut = classify('earthquakes', snapshot({ stats: { count: 0 } }), {
    timedOut: true,
    timeoutMs: 45_000,
  });
  assert.equal(timedOut.status, 'FAIL');
  assert.match(timedOut.reason, /timed out/);
});

test('a CelesTrak 502 is an EXTERNAL failure, not an app failure', () => {
  const result = classify(
    'satellites',
    snapshot({
      stats: {
        count: 0,
        error: 'CelesTrak unreachable',
        status: 'unavailable',
      },
    }),
    {
      evidence: [
        { status: 502, url: '/api/celestrak/stations' },
        { status: 502, url: '/api/celestrak/visual' },
      ],
    },
  );
  assert.equal(result.status, 'EXTERNAL');
  assert.equal(result.evidence.length, 2);
  assert.match(result.reason, /CelesTrak/);
});

test('a declared external error without scoped transient evidence is a FAIL', () => {
  const result = classify(
    'satellites',
    snapshot({ stats: { count: 0, error: 'CelesTrak unreachable' } }),
    {
      evidence: [{ status: 200, url: '/api/celestrak/stations' }],
    },
  );
  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /no 429\/502\/503\/504 or request failure/);

  // A bare 500 can be the app's own proxy failure; it is not proof that the
  // upstream provider was the cause.
  const proxyFailure = classify(
    'satellites',
    snapshot({ stats: { count: 0, error: 'CelesTrak unreachable' } }),
    {
      evidence: [{ status: 500, url: '/api/celestrak/stations' }],
    },
  );
  assert.equal(proxyFailure.status, 'FAIL');
});

test('a declared 429 also counts as external evidence', () => {
  const result = classify(
    'satellites',
    snapshot({ stats: { count: 0, error: 'CelesTrak unreachable' } }),
    {
      evidence: [{ status: 429, url: '/api/celestrak/stations' }],
    },
  );
  assert.equal(result.status, 'EXTERNAL');
  assert.match(result.reason, /HTTP 429/);
});

test('a CelesTrak request failure counts as external evidence', () => {
  const result = classify(
    'satellites',
    snapshot({ stats: { count: 0, error: 'CelesTrak unreachable' } }),
    {
      evidence: [
        {
          error: 'net::ERR_TIMED_OUT',
          url: '/api/celestrak/stations',
        },
      ],
    },
  );
  assert.equal(result.status, 'EXTERNAL');
});

test('Overpass is UNCONFIGURED only when its capability probe agrees', () => {
  const state = snapshot({
    stats: { count: 0, error: 'Overpass endpoint not configured' },
  });
  const off = classify('osm-places', state, { overpassConfigured: false });
  assert.equal(off.status, 'UNCONFIGURED');
  assert.match(off.reason, /OVERPASS_UPSTREAMS/);

  const contradiction = classify('osm-places', state, {
    overpassConfigured: true,
  });
  assert.equal(contradiction.status, 'FAIL');
  assert.match(contradiction.reason, /did not confirm configured=false/);

  const unknown = classify('osm-places', state, {
    overpassConfigured: null,
  });
  assert.equal(unknown.status, 'FAIL');
  assert.match(unknown.reason, /unreachable/);
});

test('an unregistered layer or a throwing getStats is a failure', () => {
  const missing = classify('earthquakes', { exists: false });
  assert.equal(missing.status, 'MISSING');

  const thrown = classify(
    'earthquakes',
    snapshot({ stats: null, statsError: 'boom' }),
  );
  assert.equal(thrown.status, 'FAIL');
  assert.match(thrown.reason, /getStats\(\) threw/);
});
