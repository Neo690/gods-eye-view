import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { APPLICATION_LAYER_METADATA } from '../src/app/constructCatalog.js';
import {
  missingFixtureVerdict,
  strictUnmockedVerdict,
  validateManifestShape,
} from './qa-layer-activation-matrix.mjs';
import {
  FIXTURE_IDS,
  GLOBAL_FIXTURE_IDS,
  fixtureFor,
} from './fixtures/layer-activation/network.mjs';
import {
  FIXTURE_SCHEMA_EXEMPTIONS,
  PROBED_FIXTURE_IDS,
  fixtureSchemaCoverageErrors,
  fixtureSchemaDrift,
  fixtureSchemaFingerprints,
  schemaShape,
} from './fixtures/layer-activation/schema-probes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(resolve(HERE, 'layer-activation-coverage.json'), 'utf8'),
);
const catalogIds = APPLICATION_LAYER_METADATA.map(({ id }) => id);
const schemaSnapshot = JSON.parse(
  readFileSync(
    resolve(HERE, 'fixtures/layer-activation/schema-snapshots.json'),
    'utf8',
  ),
);

test('the coverage manifest matches the application catalog one-for-one', () => {
  assert.equal(catalogIds.length, 54);
  assert.equal(new Set(catalogIds).size, 54);
  assert.deepEqual(
    Object.keys(manifest.layers).sort(),
    [...catalogIds].sort(),
    'a layer added to or removed from the catalog must change the matrix manifest in the same review',
  );
});

test('coverage manifest names every runtime layer with a fixture or an exception', () => {
  const entries = Object.entries(manifest.layers);
  assert.equal(entries.length, 54, 'the runtime registry has 54 layers');
  for (const [id, entry] of entries) {
    const fixtures = Array.isArray(entry.fixtures) ? entry.fixtures : [];
    assert.ok(
      fixtures.length > 0 || entry.exception,
      `${id} has neither a fixture nor an exception`,
    );
    assert.ok(
      fixtures.length === 0 || !entry.exception,
      `${id} has both fixtures and an exception`,
    );
    assert.ok(
      entry.credit || entry.creditException,
      `${id} has neither a credit nor a credit exception`,
    );
  }
});

test('the manifest shape check rejects a missing layer, a contradiction and an unknown fixture', () => {
  const layerIds = Object.keys(manifest.layers);
  const base = validateManifestShape(manifest, { layerIds });
  assert.equal(base.ok, true, base.errors.join('\n'));

  const missing = structuredClone(manifest);
  delete missing.layers.flights;
  const missingResult = validateManifestShape(missing, { layerIds });
  assert.equal(missingResult.ok, false);
  assert.ok(missingResult.errors.some((error) => error.includes('flights')));

  const contradiction = structuredClone(manifest);
  contradiction.layers.flights.exception = 'both are not allowed';
  const contradictionResult = validateManifestShape(contradiction, {
    layerIds,
  });
  assert.equal(contradictionResult.ok, false);
  assert.ok(
    contradictionResult.errors.some((error) =>
      error.includes('mutually exclusive'),
    ),
  );

  const unknown = structuredClone(manifest);
  unknown.layers.flights.fixtures = ['not-a-fixture'];
  const unknownResult = validateManifestShape(unknown, { layerIds });
  assert.equal(unknownResult.ok, false);
  assert.ok(
    unknownResult.errors.some((error) => error.includes('not-a-fixture')),
  );
});

test('a fixture-backed activation row needs a note and a positive count floor', () => {
  const zero = structuredClone(manifest);
  zero.layers.flights.data = { kind: 'count', min: 0 };
  const zeroResult = validateManifestShape(zero, {
    layerIds: Object.keys(zero.layers),
  });
  assert.equal(zeroResult.ok, false);
  assert.ok(
    zeroResult.errors.some((error) => error.includes('data.min')),
    zeroResult.errors.join('\n'),
  );

  const activation = structuredClone(manifest);
  activation.layers.flights.data = { kind: 'activation' };
  delete activation.layers.flights.note;
  const activationResult = validateManifestShape(activation, {
    layerIds: Object.keys(activation.layers),
  });
  assert.equal(activationResult.ok, false);
  assert.ok(
    activationResult.errors.some((error) => error.includes('needs a note')),
    activationResult.errors.join('\n'),
  );

  assert.ok(manifest.layers['orbit-changes'].note);
});

test('the missing-fixture control requires a real 503 and rejects a silent zero', () => {
  const events = [
    { kind: 'unmocked', url: '/api/flights?lat=30.2&lon=-97.7', status: 503 },
  ];
  const realFailure = missingFixtureVerdict(
    {
      data: { ok: false, reason: 'layer reports error: Flights HTTP 503' },
      stats: { count: 0, status: 503 },
    },
    events,
  );
  assert.equal(realFailure.ok, true, realFailure.reason);
  assert.equal(realFailure.unmocked.length, 1);

  const silentZero = missingFixtureVerdict(
    { data: { ok: true }, stats: { count: 0, status: 200 } },
    events,
  );
  assert.equal(silentZero.ok, false, 'a zero-aircraft success must fail');
  assert.match(silentZero.reason, /did not fail/);

  const no503 = missingFixtureVerdict(
    {
      data: { ok: false, reason: 'layer reports error: Flights HTTP 500' },
      stats: { count: 0, status: 500 },
    },
    events,
  );
  assert.equal(no503.ok, false, 'only a 503 proves the removed fixture path');
  assert.match(no503.reason, /expected 503/);
});

test('every fixture the manifest references exists in the network registry', () => {
  const known = new Set(FIXTURE_IDS);
  for (const [id, entry] of Object.entries(manifest.layers)) {
    for (const fixture of entry.fixtures ?? []) {
      assert.ok(
        known.has(fixture),
        `${id} references unknown fixture ${fixture}`,
      );
    }
  }
});

test('the coverage contract is enforced and cannot silently regress', () => {
  assert.equal(manifest.contract.fixtureBackedMin, 37);
  assert.equal(manifest.contract.exceptionsMax, 17);

  // Moving a fixture-backed layer to an exception must fail both bounds.
  const regressed = structuredClone(manifest);
  delete regressed.layers.flights.fixtures;
  regressed.layers.flights.exception = 'moved for the regression test';
  const result = validateManifestShape(regressed, {
    layerIds: Object.keys(regressed.layers),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes('fixture-backed coverage')),
  );
  assert.ok(
    result.errors.some((error) => error.includes('documented exceptions')),
  );
});

test('every network fixture is referenced by at least one layer or is global', () => {
  const used = new Set(GLOBAL_FIXTURE_IDS);
  for (const entry of Object.values(manifest.layers)) {
    for (const fixture of entry.fixtures ?? []) used.add(fixture);
  }
  const unused = FIXTURE_IDS.filter((id) => !used.has(id));
  assert.deepEqual(unused, [], `unreferenced fixtures: ${unused.join(', ')}`);
});

test('global fixtures cover app-session requests outside every layer', () => {
  assert.deepEqual(GLOBAL_FIXTURE_IDS, [
    'google-tiles-token',
    'realtime-debug-log',
  ]);

  const token = fixtureFor('http://127.0.0.1/api/google/tiles-token');
  assert.equal(token?.id, 'google-tiles-token');
  assert.equal(token.response.status, 200);
  assert.deepEqual(JSON.parse(token.response.body), {});

  const debugLog = fixtureFor('http://127.0.0.1/api/realtime/debug-log');
  assert.equal(debugLog?.id, 'realtime-debug-log');
  assert.equal(debugLog.response.status, 204);
  assert.equal(debugLog.response.body, null);
});

test('strict mode rejects any /api request left without a fixture', () => {
  const clean = strictUnmockedVerdict({
    strict: true,
    total: 0,
    urls: [],
  });
  assert.equal(clean.ok, true);

  const leaked = strictUnmockedVerdict({
    strict: true,
    total: 1,
    urls: ['/api/google/tiles-token', '/api/realtime/debug-log'],
  });
  assert.equal(leaked.ok, false);
  assert.equal(leaked.count, 2);
  assert.match(leaked.reason, /2 unmocked \/api request/);
  assert.match(leaked.reason, /google\/tiles-token/);
  assert.match(leaked.reason, /realtime\/debug-log/);

  const reportOnly = strictUnmockedVerdict({
    strict: false,
    total: 1,
    urls: ['/api/google/tiles-token'],
  });
  assert.equal(reportOnly.ok, true);
  assert.equal(reportOnly.count, 1);
});

test('every fixture schema matches its pinned fingerprint', () => {
  const actual = fixtureSchemaFingerprints();
  const drift = fixtureSchemaDrift(schemaSnapshot.fixtures ?? {}, actual);
  assert.deepEqual(
    drift,
    [],
    `fixture schema drift: ${drift.join(', ')}. Review the provider change, update the fixture, then run npm run qa:fixture-drift -- --write.`,
  );
  assert.deepEqual(
    Object.keys(schemaSnapshot.fixtures ?? {}).sort(),
    Object.keys(actual).sort(),
  );
});

test('every matrix fixture is schema-probed or explicitly exempt', () => {
  assert.deepEqual(
    fixtureSchemaCoverageErrors(),
    [],
    'a new fixture must add a schema probe or a reviewed exemption',
  );
  assert.ok(PROBED_FIXTURE_IDS.length >= 40);
  assert.ok(Object.keys(FIXTURE_SCHEMA_EXEMPTIONS).length >= 8);
});

test('the fixture drift check ignores values but catches shape changes', () => {
  assert.equal(schemaShape({ count: 1 }), schemaShape({ count: 2 }));
  assert.notEqual(
    schemaShape({ count: 1 }),
    schemaShape({ count: 1, added: true }),
  );
  assert.notEqual(
    schemaShape({ rows: [{ id: 1 }] }),
    schemaShape({ rows: [{ id: 1, name: 'qa' }] }),
  );
});

test('the fixture drift check rejects a changed schema', () => {
  const actual = fixtureSchemaFingerprints();
  const changed = { ...actual, 'flights#default': '0'.repeat(64) };
  assert.deepEqual(fixtureSchemaDrift(actual, changed), ['flights#default']);
  assert.deepEqual(fixtureSchemaDrift(changed, actual), ['flights#default']);
});

test('every QA script an exception defers to exists', () => {
  const named = new Set();
  for (const entry of Object.values(manifest.layers)) {
    for (const match of String(entry.exception ?? '').matchAll(
      /qa-[a-z0-9-]+\.mjs/g,
    )) {
      named.add(match[0]);
    }
  }
  assert.ok(
    named.size >= 4,
    'the interactive exceptions name their owning harness',
  );
  for (const script of named) {
    assert.ok(existsSync(resolve(HERE, script)), `${script} does not exist`);
  }
});
