import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  validateKeyedCoverage,
  validateKeylessInventory,
  validateKeylessManifest,
} from './qa-keyless-live-layers.mjs';
import {
  REGIONS,
  applyKeyedWorkflow,
  validateKeyedWorkflowManifest,
} from './keyed-live-layers-workflow.mjs';

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

test('a required key needs an explicit keyed canary decision', () => {
  const layers = [...APPLICATION_LAYER_METADATA, { id: 'new-keyed-layer' }];
  const declarations = {
    ...LAYER_KEY_DECLARATIONS,
    'new-keyed-layer': { keys: ['firms'], required: true },
  };

  const missing = validateKeylessInventory({ layers, declarations });
  assert.equal(missing.ok, false);
  assert.ok(
    missing.errors.some(
      (error) =>
        error.includes('new-keyed-layer') &&
        error.includes('no keyed canary entry or motivated exemption'),
    ),
    missing.errors.join('\n'),
  );

  const keyedManifest = [
    ...KEYED_LAYERS,
    { id: 'new-keyed-layer', keyId: 'firms', env: ['FIRMS_MAP_KEY'] },
  ];
  const included = validateKeylessInventory({
    layers,
    declarations,
    keyedManifest,
  });
  assert.equal(included.ok, true, included.errors.join('\n'));
  assert.ok(!included.keylessIds.includes('new-keyed-layer'));

  const exempted = validateKeylessInventory({
    layers,
    declarations,
    keyedExemptions: {
      'new-keyed-layer':
        'The provider cannot be exercised without a contract we do not have.',
    },
  });
  assert.equal(exempted.ok, true, exempted.errors.join('\n'));

  const blank = validateKeylessInventory({
    layers,
    declarations,
    keyedExemptions: { 'new-keyed-layer': '   ' },
  });
  assert.equal(blank.ok, false);
  assert.ok(
    blank.errors.some(
      (error) =>
        error.includes('new-keyed-layer') &&
        error.includes('no keyed canary entry or motivated exemption'),
    ),
    blank.errors.join('\n'),
  );
});

test('removing AIS from the keyed manifest fails validation', () => {
  const keyedManifest = KEYED_LAYERS.filter(
    ({ id }) => id !== 'ais-live-vessels',
  );
  const inventory = validateKeylessInventory({ keyedManifest });
  assert.equal(inventory.ok, false);
  assert.ok(
    inventory.errors.some(
      (error) =>
        error.includes('ais-live-vessels') &&
        error.includes('no keyed canary entry or motivated exemption'),
    ),
    inventory.errors.join('\n'),
  );
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
    [
      'local-firms',
      'conflict-events',
      'fishing-effort',
      'traffic',
      'ais-live-vessels',
    ],
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

test('the live workflow wires every keyed secret only into the keyed preview', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/live-layers.yml', import.meta.url),
    'utf8',
  );
  const between = (start, end) => {
    const from = workflow.indexOf(start);
    assert.ok(from >= 0, `workflow is missing ${start}`);
    const to = workflow.indexOf(end, from);
    assert.ok(to > from, `workflow is missing ${end} after ${start}`);
    return workflow.slice(from, to);
  };
  const detection = between(
    'Detect keyed provider secrets',
    'Resolve layer selection',
  );
  const keylessPreview = between(
    'Start keyless preview',
    'Keyless live layer gate',
  );
  const keyedPreview = between('Start keyed preview', 'Keyed live layer gate');

  assert.doesNotMatch(
    keylessPreview,
    /\$\{\{\s*secrets\./,
    'the keyless preview must never receive provider secrets',
  );

  for (const { id, env } of KEYED_LAYERS) {
    assert.match(
      detection,
      new RegExp(`add ${id};`),
      `${id} is in KEYED_LAYERS but the workflow never selects it`,
    );
    for (const name of env) {
      const secret = new RegExp(`\\$\\{\\{ secrets\\.${name} \\}\\}`);
      assert.match(
        detection,
        secret,
        `${name} is not read by keyed secret detection`,
      );
      assert.match(
        keyedPreview,
        secret,
        `${name} is not passed to the keyed preview`,
      );
    }
  }
});

const readWorkflow = () =>
  readFileSync(
    new URL('../.github/workflows/live-layers.yml', import.meta.url),
    'utf8',
  );

/** Drop both generated region bodies, leaving markers and hand-written YAML. */
const withoutGeneratedRegions = (source) => {
  let text = source;
  for (const region of Object.values(REGIONS)) {
    const begin = text.indexOf(`# BEGIN GENERATED ${region}`);
    assert.ok(begin >= 0, `workflow is missing the ${region} begin marker`);
    const endMarker = `# END GENERATED ${region}`;
    const end = text.indexOf(endMarker, begin);
    assert.ok(end > begin, `workflow is missing the ${region} end marker`);
    text = `${text.slice(0, begin)}${text.slice(end + endMarker.length)}`;
  }
  return text;
};

test('the workflow keyed wiring is exactly what KEYED_LAYERS generates', () => {
  const workflow = readWorkflow();

  assert.equal(
    applyKeyedWorkflow(workflow),
    workflow,
    'the keyed wiring in .github/workflows/live-layers.yml no longer matches KEYED_LAYERS; run "node scripts/keyed-live-layers-workflow.mjs --write" and commit the result',
  );

  // Every secret the workflow touches comes out of the generated regions, so
  // a hand-written mapping cannot reintroduce the duplicated list and the
  // keyless preview cannot acquire a credential by accident.
  assert.doesNotMatch(
    withoutGeneratedRegions(workflow),
    /\$\{\{\s*secrets\./,
    'a provider secret is wired outside the generated keyed regions',
  );
});

test('the workflow can run one layer on dispatch without the other gate', () => {
  const workflow = readWorkflow();
  const between = (start, end) => {
    const from = workflow.indexOf(start);
    assert.ok(from >= 0, `workflow is missing ${start}`);
    const to = workflow.indexOf(end, from);
    assert.ok(to > from, `workflow is missing ${end} after ${start}`);
    return workflow.slice(from, to);
  };

  assert.match(
    between('workflow_dispatch:', 'permissions:'),
    /layers:\n\s+description:/,
    'the dispatch needs a layers input',
  );

  const selection = between('select:', 'live:');
  assert.match(selection, /scripts\/live-layer-selection\.mjs/);
  assert.match(selection, /--layers "\$LAYERS" --detected "\$DETECTED"/);
  assert.match(selection, /DETECTED: \$\{\{ steps\.keys\.outputs\.only \}\}/);
  assert.match(selection, /only: \$\{\{ steps\.selection\.outputs\.only \}\}/);
  assert.match(
    selection,
    /group: \$\{\{ steps\.selection\.outputs\.group \}\}/,
  );

  // The canary job waits for the resolved filter and keys its concurrency group
  // on it, so a filtered dispatch cannot cancel the nightly run or the reverse.
  const live = workflow.slice(workflow.indexOf('live:'));
  assert.match(live, /needs: select/);
  assert.match(
    live,
    /group: live-layer-canary-\$\{\{ needs\.select\.outputs\.group \}\}/,
  );
  assert.match(live, /cancel-in-progress: true/);
  assert.doesNotMatch(
    live,
    /steps\.(selection|keys)/,
    'the canary job must read the resolved selection from the select job',
  );
  assert.doesNotMatch(
    workflow.slice(0, workflow.indexOf('jobs:')),
    /^concurrency:/m,
    'a fixed workflow-level concurrency group would cancel the nightly run',
  );

  // A keyless-only selection must skip both keyless steps' partner gate, and
  // the keyless preview must still never receive a secret.
  const keylessPreview = between(
    'Start keyless preview',
    'Keyless live layer gate',
  );
  assert.match(keylessPreview, /needs\.select\.outputs\.keyless/);
  assert.doesNotMatch(keylessPreview, /\$\{\{\s*secrets\./);

  const keylessGate = between('Keyless live layer gate', 'Start keyed preview');
  assert.match(keylessGate, /needs\.select\.outputs\.keyless/);
  assert.match(keylessGate, /--only "\$KEYLESS_ONLY"/);

  // The keyed path runs exactly the layers the select job resolved, so a
  // filtered run cannot quietly start the keyed preview for other layers.
  assert.match(
    between('Start keyed preview', 'Keyed live layer gate'),
    /needs\.select\.outputs\.only != ''/,
  );
  assert.match(
    between('Keyed live layer gate', 'Preview server logs'),
    /ONLY: \$\{\{ needs\.select\.outputs\.only \}\}/,
  );
});

test('the workflow drift check catches a keyed layer missing from the wiring', () => {
  const workflow = readWorkflow();

  const added = [
    ...KEYED_LAYERS,
    { id: 'new-keyed-feed', keyId: 'firms', env: ['NEW_FEED_TOKEN'] },
  ];
  const withFeed = applyKeyedWorkflow(workflow, { manifest: added });
  assert.notEqual(withFeed, workflow);
  assert.match(
    withFeed,
    /if \[ -n "\$\{NEW_FEED_TOKEN:-\}" \]; then add new-keyed-feed; fi/,
  );
  // Detection and the keyed preview each need the secret; nothing else does.
  assert.equal(
    withFeed.match(/NEW_FEED_TOKEN: \$\{\{ secrets\.NEW_FEED_TOKEN \}\}/g)
      ?.length,
    2,
  );

  const removed = applyKeyedWorkflow(workflow, {
    manifest: KEYED_LAYERS.filter(({ id }) => id !== 'traffic'),
  });
  assert.doesNotMatch(removed, /add traffic;/);
  assert.doesNotMatch(removed, /TOMTOM_API_KEY/);
  assert.match(removed, /add ais-live-vessels;/);
});

test('a keyed layer that cannot be rendered into the workflow is refused', () => {
  const workflow = readWorkflow();

  const injection = [
    ...KEYED_LAYERS,
    { id: 'bad-id; curl attacker', env: ['TOKEN'] },
  ];
  const idValidation = validateKeyedWorkflowManifest(injection);
  assert.equal(idValidation.ok, false);
  assert.ok(
    idValidation.errors.some((error) => error.includes('shell-safe')),
    idValidation.errors.join('\n'),
  );
  assert.throws(
    () => applyKeyedWorkflow(workflow, { manifest: injection }),
    /cannot be rendered/,
  );

  const badEnv = [
    ...KEYED_LAYERS,
    { id: 'new-keyed-feed', env: ['lower_case_name'] },
  ];
  assert.equal(validateKeyedWorkflowManifest(badEnv).ok, false);
  assert.throws(() => applyKeyedWorkflow(workflow, { manifest: badEnv }));
});

test('every required-key layer has a keyed entry or a motivated exemption', () => {
  const live = validateKeyedCoverage();
  assert.equal(live.ok, true, live.errors.join('\n'));

  const declarations = {
    ...LAYER_KEY_DECLARATIONS,
    'new-required-layer': { keys: ['firms'], required: true },
  };
  const missing = validateKeyedCoverage({ declarations });
  assert.equal(missing.ok, false);
  assert.ok(
    missing.errors.some(
      (error) =>
        error.includes('new-required-layer') &&
        error.includes('no keyed canary entry or motivated exemption'),
    ),
    missing.errors.join('\n'),
  );

  const exemptions = {
    'new-required-layer':
      'The provider only exposes a keyed endpoint that needs a contract we do not have.',
  };
  const exempted = validateKeyedCoverage({ declarations, exemptions });
  assert.equal(exempted.ok, true, exempted.errors.join('\n'));

  const blank = validateKeyedCoverage({
    declarations,
    exemptions: { 'new-required-layer': '   ' },
  });
  assert.equal(blank.ok, false);
  assert.ok(
    blank.errors.some((error) => error.includes('exemption needs a reason')),
    blank.errors.join('\n'),
  );

  const stale = validateKeyedCoverage({
    exemptions: { flights: 'Not a required-key layer.' },
  });
  assert.equal(stale.ok, false);
  assert.ok(
    stale.errors.some(
      (error) =>
        error.includes('flights') && error.includes('does not require a key'),
    ),
    stale.errors.join('\n'),
  );
});

test('the keyed AIS canary treats a missing key and an outage differently', () => {
  const ais = KEYED_LAYERS.find(({ id }) => id === 'ais-live-vessels');
  assert.ok(ais);

  const missing = classifyLayerOutcome({
    layer: ais,
    snapshot: snapshot({
      stats: { count: 0, error: 'AISSTREAM_API_KEY is not set' },
    }),
    evidence: [{ status: 503, url: '/api/vessels' }],
  });
  assert.equal(missing.status, 'FAIL');
  assert.match(missing.reason, /credential failure/);
  assert.ok(isCredentialFailure('AISSTREAM_API_KEY not set'));

  const outage = classifyLayerOutcome({
    layer: ais,
    snapshot: snapshot({
      stats: { count: 0, error: 'AISStream feed unavailable' },
    }),
    evidence: [{ status: 503, url: '/api/vessels' }],
  });
  assert.equal(outage.status, 'EXTERNAL');
  assert.match(outage.reason, /AISStream/);
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
