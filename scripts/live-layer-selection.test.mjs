import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  SCHEDULED_LAYERS,
  concurrencyGroup,
  detectKeyedLayers,
  parseLayerFilter,
  renderGithubOutput,
  resolveLayerSelection,
  scheduledLayers,
} from './live-layer-selection.mjs';
import { KEYED_LAYERS, KEYLESS_LAYERS } from './live-layer-manifests.mjs';

const SIX_HOURLY = Object.keys(SCHEDULED_LAYERS)[0];

test('a filtered run narrows each gate to the requested layers', () => {
  const keyed = resolveLayerSelection({
    requested: ['ais-live-vessels'],
    detected: ['local-firms', 'traffic', 'ais-live-vessels'],
  });
  assert.equal(keyed.ok, true, keyed.errors.join('\n'));
  assert.equal(keyed.filtered, true);
  assert.equal(keyed.keyless, '');
  assert.equal(keyed.only, 'ais-live-vessels');

  const keyless = resolveLayerSelection({
    requested: ['earthquakes'],
    detected: ['traffic'],
  });
  assert.equal(keyless.ok, true, keyless.errors.join('\n'));
  assert.equal(keyless.keyless, 'earthquakes');
  // A filter that names no keyed layer must not start the keyed gate.
  assert.equal(keyless.only, '');
});

test('a mixed filter keeps the requested order inside each gate', () => {
  const selection = resolveLayerSelection({
    requested: ['earthquakes', 'traffic', 'satellites', 'local-firms'],
    detected: ['traffic', 'local-firms'],
  });
  assert.equal(selection.ok, true, selection.errors.join('\n'));
  assert.equal(selection.keyless, 'earthquakes,satellites');
  assert.equal(selection.only, 'traffic,local-firms');
});

test('an unfiltered run keeps every keyed layer with a credential', () => {
  const selection = resolveLayerSelection({
    requested: [],
    detected: ['local-firms', 'traffic'],
  });
  assert.equal(selection.ok, true);
  // `filtered: false` is what tells the gates to run their whole manifest;
  // an empty keyless list therefore means "no --only", not "no work".
  assert.equal(selection.filtered, false);
  assert.equal(selection.source, 'full');
  assert.equal(selection.keyless, '');
  assert.equal(selection.only, 'local-firms,traffic');
  assert.equal(selection.group, 'full');
});

test('a requested keyed layer without a credential fails the dispatch', () => {
  const missing = resolveLayerSelection({
    requested: ['ais-live-vessels', 'traffic'],
    detected: ['traffic'],
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors[0], /ais-live-vessels/);
  assert.doesNotMatch(missing.errors[0], /traffic,/);

  const unconfigured = resolveLayerSelection({
    requested: ['ais-live-vessels'],
    detected: [],
  });
  assert.equal(unconfigured.ok, false);
});

test('an unknown layer fails the dispatch with the runnable ids', () => {
  const unknown = resolveLayerSelection({ requested: ['ais-live-vessel'] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.filtered, true);
  assert.ok(
    unknown.errors.some(
      (error) => error.includes('ais-live-vessel') && error.includes('--list'),
    ),
    unknown.errors.join('\n'),
  );

  // A layer deliberately kept out of the live canary is not runnable either.
  const excluded = resolveLayerSelection({ requested: ['cctv'] });
  assert.equal(excluded.ok, false);
  assert.ok(excluded.errors.some((error) => error.includes('cctv')));
});

test('the live manifests share no layer id, so classification is unambiguous', () => {
  const keyed = new Set(KEYED_LAYERS.map(({ id }) => id));
  for (const { id } of KEYLESS_LAYERS) {
    assert.ok(!keyed.has(id), `${id} is in both live manifests`);
  }
});

test('the filter normalises separators and repeats', () => {
  assert.deepEqual(parseLayerFilter(' traffic , ais-live-vessels\ntraffic '), [
    'traffic',
    'ais-live-vessels',
  ]);
  assert.deepEqual(parseLayerFilter(''), []);
  assert.deepEqual(parseLayerFilter(null), []);
});

test('the present secret names decide which keyed layers can run', () => {
  const { detected, skipped } = detectKeyedLayers([
    'FIRMS_MAP_KEY',
    'ACLED_EMAIL',
  ]);
  assert.deepEqual(detected, ['local-firms']);
  assert.deepEqual(
    skipped.map((entry) => entry.id),
    ['conflict-events', 'fishing-effort', 'traffic', 'ais-live-vessels'],
  );

  const conflict = skipped.find((entry) => entry.id === 'conflict-events');
  assert.equal(conflict.partial, true);
  assert.match(conflict.reason, /partial credential/);
  assert.match(conflict.reason, /ACLED_PASSWORD/);
  // A name is reported, a value never is.
  assert.doesNotMatch(conflict.reason, /=\s*\S/);

  const ais = skipped.find((entry) => entry.id === 'ais-live-vessels');
  assert.equal(ais.partial, false);
  assert.match(ais.reason, /no credential set \(needs AISSTREAM_API_KEY\)/);

  // Every layer with a full env list runs, so a complete secret set skips
  // nothing at all.
  const complete = detectKeyedLayers(
    KEYED_LAYERS.flatMap((layer) => layer.env ?? []),
  );
  assert.equal(complete.skipped.length, 0);
  assert.equal(complete.detected.length, KEYED_LAYERS.length);
});

test('a present name list resolves to the layers it can run', () => {
  const selection = resolveLayerSelection({
    present: ['TOMTOM_API_KEY', 'AISSTREAM_API_KEY'],
  });
  assert.equal(selection.ok, true);
  assert.equal(selection.only, 'traffic,ais-live-vessels');
  assert.equal(selection.filtered, false);
  assert.deepEqual(
    selection.skipped.map((entry) => entry.id),
    ['local-firms', 'conflict-events', 'fishing-effort'],
  );
});

test('the six-hourly schedule runs its one keyed layer', () => {
  const selection = resolveLayerSelection({
    schedule: SIX_HOURLY,
    present: ['AISSTREAM_API_KEY'],
  });
  assert.equal(selection.ok, true, selection.errors.join('\n'));
  assert.equal(selection.source, 'schedule');
  assert.equal(selection.filtered, true);
  assert.equal(selection.keyless, '');
  assert.equal(selection.only, 'ais-live-vessels');
  // Its own group, so it never cancels the nightly run.
  assert.equal(selection.group, 'filter-ais-live-vessels');
});

test('a scheduled layer without a credential is skipped, not failed', () => {
  const selection = resolveLayerSelection({
    schedule: SIX_HOURLY,
    present: [],
  });
  assert.equal(selection.ok, true, selection.errors.join('\n'));
  assert.equal(selection.only, '');
  assert.equal(selection.keyless, '');
  const ais = selection.skipped.find(
    (entry) => entry.id === 'ais-live-vessels',
  );
  assert.ok(ais, selection.skipped.map((entry) => entry.id).join(', '));
  assert.match(ais.reason, /AISSTREAM_API_KEY/);
});

test('the nightly cron still runs the whole manifest', () => {
  const selection = resolveLayerSelection({
    schedule: '41 6 * * *',
    present: ['FIRMS_MAP_KEY'],
  });
  assert.equal(selection.source, 'full');
  assert.equal(selection.filtered, false);
  assert.equal(selection.group, 'full');
  assert.equal(selection.only, 'local-firms');
  assert.deepEqual(scheduledLayers('41 6 * * *'), []);
  assert.deepEqual(scheduledLayers(''), []);
  assert.deepEqual(scheduledLayers('17 */6 * * *'), ['ais-live-vessels']);
});

test('a dispatch filter wins over the schedule it was dispatched from', () => {
  const selection = resolveLayerSelection({
    requested: ['earthquakes'],
    schedule: SIX_HOURLY,
    present: [],
  });
  assert.equal(selection.ok, true, selection.errors.join('\n'));
  assert.equal(selection.source, 'dispatch');
  assert.equal(selection.keyless, 'earthquakes');
  assert.equal(selection.only, '');
});

test('the GitHub output is one key per line with an explicit filtered flag', () => {
  assert.equal(
    renderGithubOutput(
      resolveLayerSelection({
        requested: ['traffic'],
        detected: ['traffic'],
      }),
    ),
    'filtered=true\nsource=dispatch\nkeyless=\nonly=traffic\ngroup=filter-traffic\nskipped=[]\n',
  );
  assert.equal(
    renderGithubOutput(
      resolveLayerSelection({ requested: [], present: ['ACLED_EMAIL'] }),
    ),
    'filtered=false\nsource=full\nkeyless=\nonly=\ngroup=full\nskipped=[{"id":"local-firms","provider":"NASA FIRMS","partial":false,"reason":"no credential set (needs FIRMS_MAP_KEY)"},{"id":"conflict-events","provider":"ACLED","partial":true,"reason":"partial credential: ACLED_EMAIL is set but ACLED_PASSWORD is missing"},{"id":"fishing-effort","provider":"Global Fishing Watch","partial":false,"reason":"no credential set (needs GFW_API_TOKEN)"},{"id":"traffic","provider":"TomTom","partial":false,"reason":"no credential set (needs TOMTOM_API_KEY)"},{"id":"ais-live-vessels","provider":"AISStream","partial":false,"reason":"no credential set (needs AISSTREAM_API_KEY)"}]\n',
  );
  // The skipped list is one line, so it survives a step output.
  assert.doesNotMatch(
    renderGithubOutput(resolveLayerSelection({ present: [] })),
    /\n\s*\n/,
  );
});

test('the concurrency key follows the resolved filter and never collides with the nightly run', () => {
  assert.equal(concurrencyGroup([]), 'full');
  assert.equal(concurrencyGroup(['b', 'a']), 'filter-a+b');
  // The same set requested in another order is the same workload, so it must
  // cancel itself rather than run twice.
  assert.equal(concurrencyGroup(['a', 'b']), concurrencyGroup(['b', 'a']));
  assert.equal(concurrencyGroup(['a', 'a']), 'filter-a');

  assert.equal(
    resolveLayerSelection({
      requested: ['ais-live-vessels'],
      detected: ['ais-live-vessels'],
    }).group,
    'filter-ais-live-vessels',
  );
  assert.equal(
    resolveLayerSelection({
      requested: ['traffic', 'earthquakes'],
      detected: ['traffic'],
    }).group,
    'filter-earthquakes+traffic',
  );
});

/** Import specifiers in a module's source, including re-exports. */
const importSpecifiers = (source) =>
  [
    ...source.matchAll(/^import\s+[^'"]*from\s+['"]([^'"]+)['"]/gm),
    ...source.matchAll(/^export\s+[^'"]*from\s+['"]([^'"]+)['"]/gm),
    ...source.matchAll(/^import\s+['"]([^'"]+)['"]/gm),
  ].map((match) => match[1]);

const readScript = (name) =>
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

test('the filter and the manifests stay dependency-free', () => {
  assert.deepEqual(
    importSpecifiers(readScript('live-layer-manifests.mjs')),
    [],
    'the manifests module must stay data-only so the workflow can resolve a filter before npm ci',
  );
  assert.deepEqual(
    importSpecifiers(readScript('live-layer-selection.mjs')).sort(),
    ['./live-layer-manifests.mjs', 'node:path', 'node:url'],
  );
});

test('the gate imports the manifests module and keeps its exports', () => {
  const runner = readScript('qa-keyless-live-layers.mjs');
  assert.match(
    runner,
    /import \{ KEYED_LAYERS, KEYLESS_LAYERS \} from '\.\/live-layer-manifests\.mjs';/,
  );
  assert.match(runner, /export \{ KEYED_LAYERS, KEYLESS_LAYERS \};/);
  // The runner is the only place that may pull the browser driver in.
  assert.match(runner, /^import puppeteer from 'puppeteer';$/m);
});
