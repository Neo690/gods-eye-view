import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ESCALATION_THRESHOLD,
  HISTORY_LIMIT,
  buildRun,
  diffRuns,
  escalatedLayers,
  layerStreak,
  parseTrackingBody,
  planTracking,
  recordRun,
  renderSummary,
  renderTrackingBody,
  renderTrackingComment,
  shouldComment,
} from './live-layer-canary.mjs';

const STATUSES = [
  'PASS',
  'EMPTY',
  'UNCONFIGURED',
  'EXTERNAL',
  'FAIL',
  'MISSING',
];

const makeReport = (layers) => ({
  ok: !layers.some((layer) => ['FAIL', 'MISSING'].includes(layer.status)),
  strict: false,
  summary: Object.fromEntries(
    STATUSES.map((status) => [
      status.toLowerCase(),
      layers.filter((layer) => layer.status === status).length,
    ]),
  ),
  layers: layers.map((layer) => ({ reason: 'reason', ...layer })),
});

/** A run over the given `{ id: status }` map. */
const makeRun = (
  statuses,
  { conclusion = 'success', partial = false, at = '2026-11-20T06:41:00Z' } = {},
) =>
  buildRun({
    reports: [
      {
        mode: 'keyless',
        report: makeReport(
          Object.entries(statuses).map(([id, status]) => ({ id, status })),
        ),
      },
    ],
    selection: { filtered: partial },
    conclusion,
    url: 'https://example.test/actions/runs/1',
    attempt: '1',
    at,
  });

const EMPTY = { layers: {} };

test('a run records every layer and the blocking ones', () => {
  const run = makeRun({
    earthquakes: 'PASS',
    satellites: 'EXTERNAL',
    flights: 'FAIL',
  });
  assert.deepEqual(run.layers, {
    earthquakes: 'PASS',
    satellites: 'EXTERNAL',
    flights: 'FAIL',
  });
  assert.deepEqual(run.failed, ['flights']);
  assert.equal(run.partial, false);
  assert.deepEqual(run.skipped, []);
});

test('both gates feed one outcome map', () => {
  const run = buildRun({
    reports: [
      {
        mode: 'keyless',
        report: makeReport([{ id: 'earthquakes', status: 'PASS' }]),
      },
      {
        mode: 'keyed',
        report: makeReport([{ id: 'traffic', status: 'MISSING' }]),
      },
    ],
  });
  assert.deepEqual(Object.keys(run.layers).sort(), ['earthquakes', 'traffic']);
  assert.deepEqual(run.failed, ['traffic']);
});

test('the diff names what broke, degraded and recovered', () => {
  const previous = makeRun({
    earthquakes: 'PASS',
    satellites: 'PASS',
    radio: 'EMPTY',
  });
  const current = makeRun({
    earthquakes: 'FAIL',
    satellites: 'EXTERNAL',
    radio: 'PASS',
  });
  const diff = diffRuns(previous, current);
  assert.deepEqual(diff.broken, [
    { id: 'earthquakes', status: 'FAIL', before: 'PASS' },
  ]);
  assert.deepEqual(diff.degraded, [
    { id: 'satellites', status: 'EXTERNAL', before: 'PASS' },
  ]);
  assert.deepEqual(diff.recovered, [
    { id: 'radio', status: 'PASS', before: 'EMPTY' },
  ]);
});

test('a layer the previous run did not exercise cannot recover', () => {
  const previous = makeRun({ earthquakes: 'PASS' }, { partial: true });
  const current = makeRun({ earthquakes: 'PASS', flights: 'PASS' });
  const diff = diffRuns(previous, current);
  assert.deepEqual(diff.recovered, []);
  // It can still break, because "not run" is not "was passing".
  const broke = diffRuns(
    previous,
    makeRun({ earthquakes: 'PASS', flights: 'FAIL' }),
  );
  assert.deepEqual(broke.broken, [
    { id: 'flights', status: 'FAIL', before: null },
  ]);
});

test('a streak counts consecutive non-PASS outcomes and a PASS ends it', () => {
  const runs = [
    makeRun({ satellites: 'PASS', radio: 'PASS' }),
    makeRun({ satellites: 'EXTERNAL', radio: 'PASS' }),
    makeRun({ satellites: 'EMPTY', radio: 'PASS' }),
  ];
  assert.equal(layerStreak(runs, 'satellites'), 2);
  assert.equal(layerStreak(runs, 'radio'), 0);
  assert.deepEqual(escalatedLayers(runs), []);
  assert.deepEqual(escalatedLayers(runs, 2), ['satellites']);

  // A run that did not exercise the layer is stepped over, not counted as a
  // break, so a partial dispatch cannot hide a real streak.
  const partial = [
    ...runs,
    makeRun({ radio: 'PASS' }, { partial: true }),
    makeRun({ satellites: 'EXTERNAL', radio: 'PASS' }),
  ];
  assert.equal(layerStreak(partial, 'satellites'), ESCALATION_THRESHOLD);
  assert.deepEqual(escalatedLayers(partial), ['satellites']);
});

test('the first failure opens the alert and a later success recovers it', () => {
  let state = { version: 1, runs: [] };
  const first = planTracking({
    state,
    run: makeRun({ flights: 'FAIL' }, { conclusion: 'failure' }),
  });
  assert.equal(first.action, 'open');
  assert.equal(first.failing, true);
  assert.equal(shouldComment(first), true);

  state = first.next;
  const again = planTracking({
    state,
    run: makeRun({ flights: 'FAIL' }, { conclusion: 'failure' }),
  });
  assert.equal(again.action, 'update');
  // Nothing new broke, so the issue body is refreshed without another comment.
  assert.equal(shouldComment(again), false);

  state = again.next;
  const newBreak = planTracking({
    state,
    run: makeRun(
      { flights: 'FAIL', radio: 'MISSING' },
      { conclusion: 'failure' },
    ),
  });
  assert.equal(newBreak.action, 'update');
  assert.equal(shouldComment(newBreak), true);

  const recovered = planTracking({
    state: newBreak.next,
    run: makeRun({ flights: 'PASS' }),
  });
  assert.equal(recovered.action, 'recovered');
  assert.equal(recovered.failing, false);
  assert.equal(shouldComment(recovered), true);
});

test('a provider stuck in EMPTY/EXTERNAL escalates without failing the run', () => {
  let state = { version: 1, runs: [] };
  for (let index = 1; index <= ESCALATION_THRESHOLD; index += 1) {
    const plan = planTracking({
      state,
      run: makeRun({ satellites: 'EXTERNAL' }),
    });
    assert.equal(plan.run.conclusion, 'success');
    if (index < ESCALATION_THRESHOLD) {
      assert.equal(plan.action, 'none');
      assert.deepEqual(plan.escalated, []);
    } else {
      // The run is green; the streak is what raises the alert.
      assert.equal(plan.action, 'open');
      assert.equal(plan.failing, true);
      assert.deepEqual(plan.escalated, ['satellites']);
    }
    state = plan.next;
  }
  const comments = renderTrackingComment(
    planTracking({ state, run: makeRun({ satellites: 'EXTERNAL' }) }),
  );
  assert.match(comments, /EMPTY\/EXTERNAL for 3\+ consecutive runs/);
});

test('the tracking issue body round-trips its history', () => {
  const run = makeRun({ earthquakes: 'PASS', satellites: 'EXTERNAL' });
  const state = recordRun({ version: 1, runs: [] }, run);
  const body = renderTrackingBody(state);
  assert.match(body, /# Live layer canary health/);
  assert.match(body, /\| satellites \| EXTERNAL \|/);
  assert.deepEqual(parseTrackingBody(body), state);

  const next = recordRun(state, makeRun({ earthquakes: 'PASS' }));
  const nextBody = renderTrackingBody(next);
  assert.match(nextBody, /\| earthquakes \| PASS \| PASS \| 0 \|/);
  assert.match(nextBody, /partial/);

  // A truncated or hand-edited block starts over rather than throwing.
  assert.deepEqual(
    parseTrackingBody('<!-- live-layer-canary-state\n{oops}\n-->'),
    {
      version: 1,
      runs: [],
    },
  );
  assert.deepEqual(parseTrackingBody(''), { version: 1, runs: [] });
});

test('the history is bounded', () => {
  let state = { version: 1, runs: [] };
  for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
    state = recordRun(state, makeRun({ earthquakes: 'PASS' }));
  }
  assert.equal(state.runs.length, HISTORY_LIMIT);
});

test('the summary labels a filtered run as partial and says what it skipped', () => {
  const summary = renderSummary({
    reports: [
      {
        mode: 'keyed',
        report: makeReport([{ id: 'ais-live-vessels', status: 'PASS' }]),
      },
    ],
    selection: {
      filtered: true,
      source: 'schedule',
      only: 'ais-live-vessels',
      group: 'filter-ais-live-vessels',
    },
    skipped: [
      {
        id: 'conflict-events',
        partial: true,
        reason:
          'partial credential: ACLED_EMAIL is set but ACLED_PASSWORD is missing',
      },
    ],
  });
  assert.match(
    summary,
    /> \*\*Partial run\.\*\* This run exercised keyed: ais-live-vessels\./,
  );
  assert.match(summary, /says nothing about them/);
  assert.match(summary, /Trigger: \*\*scheduled keyed run\*\*/);
  assert.match(summary, /### Keyed layers skipped/);
  assert.match(summary, /partial credential: ACLED_EMAIL/);
  assert.match(summary, /\| conflict-events \| partial credential/);
  assert.match(summary, /### Keyed live layers/);
  assert.match(summary, /\| ais-live-vessels \| PASS \| — \|/);
});

test('an unfiltered summary has no partial banner', () => {
  const summary = renderSummary({
    reports: [
      {
        mode: 'keyless',
        report: makeReport([{ id: 'earthquakes', status: 'PASS' }]),
      },
    ],
    selection: { filtered: false, source: 'full', group: 'full' },
  });
  assert.doesNotMatch(summary, /Partial run/);
  assert.match(summary, /Trigger: \*\*nightly schedule\*\*/);
});

test('a run with no report says so instead of rendering an empty table', () => {
  const summary = renderSummary({
    reports: [],
    selection: { filtered: false, source: 'full' },
  });
  assert.match(summary, /No live layer report was produced/);
});

test('the summary compares against the previous run and flags a streak', () => {
  const plan = planTracking({
    state: {
      version: 1,
      runs: [
        makeRun({ earthquakes: 'PASS', satellites: 'EXTERNAL' }),
        makeRun({ earthquakes: 'PASS', satellites: 'EXTERNAL' }),
      ],
    },
    run: makeRun({ earthquakes: 'FAIL', satellites: 'EXTERNAL' }),
  });
  const summary = renderSummary({
    reports: [
      {
        mode: 'keyless',
        report: makeReport([
          { id: 'earthquakes', status: 'FAIL' },
          { id: 'satellites', status: 'EXTERNAL' },
        ]),
      },
    ],
    selection: { filtered: false, source: 'full' },
    plan,
  });
  assert.match(summary, /### Since the previous run/);
  assert.match(summary, /`earthquakes` broke: PASS → FAIL/);
  assert.match(summary, /\| earthquakes \| FAIL \| PASS \|/);
  assert.match(summary, /### Escalating: 3\+ consecutive/);
});

test('a history failure is reported, not fatal', () => {
  const summary = renderSummary({
    reports: [
      {
        mode: 'keyless',
        report: makeReport([{ id: 'earthquakes', status: 'PASS' }]),
      },
    ],
    selection: { filtered: false, source: 'full' },
    historyError: 'gh: not authenticated',
  });
  assert.match(summary, /History unavailable \(gh: not authenticated\)/);
});

test('the recovery comment lists what came back', () => {
  const plan = planTracking({
    state: {
      version: 1,
      runs: [makeRun({ flights: 'MISSING' }, { conclusion: 'failure' })],
    },
    run: makeRun({ flights: 'PASS' }),
  });
  const comment = renderTrackingComment(plan);
  assert.match(comment, /\*\*Recovered\.\*\*/);
  assert.match(comment, /`flights`: MISSING → PASS/);
});

test('a failing comment links the run and names the failing layers', () => {
  const plan = planTracking({
    state: EMPTY,
    run: makeRun(
      { flights: 'FAIL', radio: 'MISSING' },
      { conclusion: 'failure' },
    ),
  });
  const comment = renderTrackingComment(plan);
  assert.match(comment, /\*\*Canary failing\.\*\*/);
  assert.match(comment, /https:\/\/example\.test\/actions\/runs\/1/);
  assert.match(comment, /Failing layers: `flights`, `radio`/);
  assert.match(comment, /Newly failing:/);
});
