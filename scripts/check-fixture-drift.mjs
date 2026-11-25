#!/usr/bin/env node
/**
 * check-fixture-drift.mjs — fail when a layer-activation fixture's JSON schema
 * changes without a deliberate snapshot update.
 *
 * Usage:
 *   node scripts/check-fixture-drift.mjs
 *   node scripts/check-fixture-drift.mjs --write
 *
 * After reviewing a provider schema change, update the fixture, run
 * `--write`, and include the resulting snapshot change in the same review.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fixtureSchemaDrift,
  fixtureSchemaFingerprints,
  fixtureSchemaSamples,
} from './fixtures/layer-activation/schema-probes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(
  HERE,
  'fixtures/layer-activation/schema-snapshots.json',
);
const WRITE = process.argv.includes('--write');
const samples = fixtureSchemaSamples();
const actual = fixtureSchemaFingerprints(samples);

if (WRITE) {
  const snapshot = {
    version: 1,
    description:
      'Pinned JSON schema fingerprints for layer-activation fixtures. Update deliberately with `npm run qa:fixture-drift -- --write` after a provider schema review.',
    fixtures: actual,
  };
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `Wrote ${Object.keys(actual).length} fixture schemas to ${SNAPSHOT_PATH}`,
  );
  process.exit(0);
}

let snapshot;
try {
  snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
} catch (error) {
  console.error(
    `Could not read fixture schema snapshot ${SNAPSHOT_PATH}: ${error.message}`,
  );
  console.error('Run `npm run qa:fixture-drift -- --write` to create it.');
  process.exit(1);
}

const expected = snapshot.fixtures ?? {};
const drift = fixtureSchemaDrift(expected, actual);
if (!drift.length) {
  console.log(`Fixture schemas match (${Object.keys(actual).length} samples).`);
  process.exit(0);
}

console.error(`Fixture schema drift in ${drift.length} sample(s):`);
for (const key of drift) {
  const sample = samples.find((entry) => entry.key === key);
  console.error(`  ${key}`);
  console.error(`    expected ${expected[key] ?? '<missing>'}`);
  console.error(`    actual   ${actual[key] ?? '<missing>'}`);
  if (sample) console.error(`    shape    ${sample.shape.slice(0, 320)}`);
}
console.error(
  'Review the provider change, update the fixture and run `npm run qa:fixture-drift -- --write`.',
);
process.exit(1);
