import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FAILING_LABEL,
  TRACKING_LABEL,
  TRACKING_TITLE,
  applyTracking,
  buildRun,
  loadTracking,
  parseTrackingBody,
  planTracking,
  renderTrackingBody,
} from './live-layer-canary.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_GH = fileURLToPath(
  new URL('./fixtures/live-layer-canary/fake-gh.mjs', import.meta.url),
);

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

const makeRun = (statuses, { conclusion = 'success', at = '' } = {}) =>
  buildRun({
    reports: [
      {
        mode: 'keyless',
        report: makeReport(
          Object.entries(statuses).map(([id, status]) => ({ id, status })),
        ),
      },
    ],
    conclusion,
    url: 'https://example.test/actions/runs/1',
    attempt: '1',
    at: at || '2026-11-20T06:41:00.000Z',
  });

/**
 * A throwaway issue world plus a runner that shells out to the fake gh exactly
 * the way `runGh` shells out to the real one.
 */
function sandbox(
  world = { nextNumber: 1, issues: [], labels: [] },
  { withWorld = true } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'gev-canary-gh-'));
  const state = join(dir, 'issue.json');
  const transcript = join(dir, 'transcript.jsonl');
  const fake = join(dir, 'fake-gh.mjs');
  copyFileSync(FAKE_GH, fake);
  if (withWorld) writeFileSync(state, `${JSON.stringify(world, null, 2)}\n`);

  const env = {
    ...process.env,
    FAKE_GH_STATE: state,
    FAKE_GH_TRANSCRIPT: transcript,
  };
  const gh = (argv) => {
    const result = spawnSync(process.execPath, [fake, ...argv], {
      encoding: 'utf8',
      env,
    });
    if (result.status !== 0) {
      throw new Error(
        (result.stderr || `fake gh exited ${result.status}`).trim(),
      );
    }
    return result.stdout;
  };

  const calls = () =>
    existsSync(transcript)
      ? readFileSync(transcript, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const readWorld = () => JSON.parse(readFileSync(state, 'utf8'));

  return { dir, state, transcript, fake, env, gh, calls, readWorld };
}

/** The subcommand of every recorded call, for a sequence assertion. */
const sequence = (calls) =>
  calls.map((call) => call.argv.slice(0, 2).join(' '));

/** Run the real CLI the way the workflow's last step does. */
function cli(box, args, env = {}) {
  return spawnSync(
    process.execPath,
    ['scripts/live-layer-canary.mjs', 'report', ...args],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...box.env,
        CANARY_GH: `${process.execPath} ${box.fake}`,
        GH_TOKEN: 'stand-in',
        GITHUB_STEP_SUMMARY: join(box.dir, 'summary.md'),
        CONCLUSION: 'success',
        ...env,
      },
    },
  );
}

test('a first failure creates the issue, comments on it and labels it', () => {
  const box = sandbox();
  const run = makeRun({ flights: 'FAIL' }, { conclusion: 'failure' });
  const state = { version: 1, runs: [] };
  const plan = planTracking({ state, run });

  const number = applyTracking(plan, { issue: null, state }, { gh: box.gh });
  assert.equal(number, 1);

  // Creation, then the alert itself: a body, a comment, and the failing label.
  assert.deepEqual(sequence(box.calls()), [
    'label create',
    'issue create',
    'issue comment',
    'label create',
    'issue edit',
  ]);

  const [issue] = box.readWorld().issues;
  assert.equal(issue.title, TRACKING_TITLE);
  assert.equal(issue.state, 'OPEN');
  assert.deepEqual(issue.labels, [TRACKING_LABEL, FAILING_LABEL]);
  assert.equal(issue.comments.length, 1);
  assert.match(issue.comments[0].body, /\*\*Canary failing\.\*\*/);
  assert.match(issue.comments[0].body, /Failing layers: `flights`/);

  // The body written by `gh issue edit/create --body-file` is the history the
  // next run reads back: it has to survive the round trip through the CLI.
  const written = parseTrackingBody(issue.body);
  assert.deepEqual(written, plan.next);
  assert.match(issue.body, /# Live layer canary health/);
  assert.match(issue.body, /\| flights \| FAIL \| — \| 0 \|/);

  const created = box.calls().find((call) => call.argv.includes('--body-file'));
  assert.ok(created.argv.includes('--title'));
});

test('a second failure edits the body and does not comment again', () => {
  const previous = makeRun({ flights: 'FAIL' }, { conclusion: 'failure' });
  const seed = { version: 1, runs: [previous] };
  const box = sandbox({
    nextNumber: 6,
    labels: [
      { name: TRACKING_LABEL, color: '0e8a16', description: '' },
      { name: FAILING_LABEL, color: 'b60205', description: '' },
    ],
    issues: [
      {
        number: 5,
        title: TRACKING_TITLE,
        body: renderTrackingBody(seed),
        state: 'OPEN',
        labels: [TRACKING_LABEL, FAILING_LABEL],
        comments: [{ body: 'earlier' }],
      },
    ],
  });

  const tracking = loadTracking({ gh: box.gh });
  assert.equal(tracking.issue.number, 5);
  assert.deepEqual(tracking.state, seed);

  const plan = planTracking({
    state: tracking.state,
    run: makeRun({ flights: 'FAIL' }, { conclusion: 'failure' }),
  });
  assert.equal(plan.action, 'update');
  assert.equal(applyTracking(plan, tracking, { gh: box.gh }), 5);

  // Nothing new broke, so the history is refreshed without a fresh comment,
  // and the failing label is re-asserted with the idempotent --force create.
  assert.deepEqual(sequence(box.calls()), [
    'issue list',
    'issue edit',
    'label create',
    'issue edit',
  ]);
  const label = box.calls().find((call) => call.argv[0] === 'label');
  assert.deepEqual(label.argv.slice(2, 3), [FAILING_LABEL]);
  assert.ok(label.argv.includes('--force'));

  const [issue] = box.readWorld().issues;
  assert.equal(box.readWorld().issues.length, 1);
  assert.equal(issue.comments.length, 1);
  assert.equal(parseTrackingBody(issue.body).runs.length, 2);
  assert.ok(issue.labels.includes(FAILING_LABEL));
});

test('a recovery reopens a closed tracker instead of starting a second one', () => {
  const seed = {
    version: 1,
    runs: [makeRun({ flights: 'MISSING' }, { conclusion: 'failure' })],
  };
  const box = sandbox({
    nextNumber: 2,
    labels: [{ name: TRACKING_LABEL, color: '0e8a16', description: '' }],
    issues: [
      {
        number: 1,
        title: TRACKING_TITLE,
        body: renderTrackingBody(seed),
        state: 'CLOSED',
        labels: [TRACKING_LABEL, FAILING_LABEL],
        comments: [],
      },
    ],
  });

  // A tracker someone closed by hand is still the tracker: the lookup has to
  // see it (`--state all`), or the history splits and the streaks reset.
  const tracking = loadTracking({ gh: box.gh });
  assert.equal(tracking.issue.number, 1);
  assert.deepEqual(tracking.state, seed);

  const plan = planTracking({
    state: tracking.state,
    run: makeRun({ flights: 'PASS' }),
  });
  assert.equal(plan.action, 'recovered');
  applyTracking(plan, tracking, { gh: box.gh });

  assert.deepEqual(sequence(box.calls()), [
    'issue list',
    'issue edit',
    'issue reopen',
    'issue comment',
    'issue edit',
  ]);
  const { issues } = box.readWorld();
  assert.equal(issues.length, 1);
  const [issue] = issues;
  assert.equal(issue.state, 'OPEN');
  assert.deepEqual(issue.labels, [TRACKING_LABEL]);
  assert.match(issue.comments[0].body, /\*\*Recovered\.\*\*/);
  assert.match(issue.comments[0].body, /`flights`: MISSING → PASS/);
  assert.equal(parseTrackingBody(issue.body).runs.length, 2);
});

test('the newest closed tracker wins when several exist', () => {
  const older = {
    version: 1,
    runs: [makeRun({ flights: 'MISSING' }, { conclusion: 'failure' })],
  };
  const newer = { version: 1, runs: [makeRun({ flights: 'EXTERNAL' })] };
  // `gh issue list` reports an order, not a promise, and the world below hands
  // back the older issue first: the lookup sorts by number, so the tracker it
  // continues is the newest one whatever order it was listed in.
  const box = sandbox({
    nextNumber: 8,
    labels: [],
    issues: [
      {
        number: 1,
        title: TRACKING_TITLE,
        body: renderTrackingBody(older),
        state: 'CLOSED',
        labels: [TRACKING_LABEL],
        comments: [],
      },
      {
        number: 7,
        title: TRACKING_TITLE,
        body: renderTrackingBody(newer),
        state: 'CLOSED',
        labels: [TRACKING_LABEL, FAILING_LABEL],
        comments: [],
      },
    ],
  });

  const tracking = loadTracking({ gh: box.gh });
  assert.equal(tracking.issue.number, 7);
  assert.deepEqual(tracking.state, newer);
});

test('the CLI runs the tracking path end to end against the stand-in', () => {
  const box = sandbox();
  const report = join(box.dir, 'keyless.json');
  const summary = join(box.dir, 'summary.md');
  writeFileSync(
    report,
    JSON.stringify(
      makeReport([
        { id: 'earthquakes', status: 'PASS' },
        { id: 'flights', status: 'FAIL' },
      ]),
    ),
  );

  const result = cli(
    box,
    ['--keyless', report, '--keyed', join(box.dir, 'absent.json')],
    {
      GITHUB_STEP_SUMMARY: summary,
      CONCLUSION: 'failure',
      RUN_URL: 'https://example.test/actions/runs/9',
      RUN_ATTEMPT: '2',
      FILTERED: 'true',
      SOURCE: 'schedule',
      ONLY: 'ais-live-vessels',
      SKIPPED: '[]',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /live layer canary: open \(issue #1\)/);
  assert.match(result.stdout, /failing=true/);

  const written = readFileSync(summary, 'utf8');
  assert.match(written, /\*\*Partial run\.\*\*/);
  assert.match(written, /### Keyless live layers/);
  assert.match(written, /\| flights \| FAIL \| — \|/);

  // The keyed report was missing; the run still recorded what it did exercise.
  const [issue] = box.readWorld().issues;
  const state = parseTrackingBody(issue.body);
  assert.equal(state.runs.length, 1);
  assert.deepEqual(state.runs[0].layers, {
    earthquakes: 'PASS',
    flights: 'FAIL',
  });
  assert.equal(state.runs[0].partial, true);
  assert.ok(issue.labels.includes(FAILING_LABEL));
});

test('a skipped run and a dry run leave the history untouched', () => {
  const box = sandbox();
  const report = join(box.dir, 'keyless.json');
  writeFileSync(
    report,
    JSON.stringify(makeReport([{ id: 'flights', status: 'PASS' }])),
  );

  const skipped = cli(box, ['--keyless', report], { CONCLUSION: 'skipped' });
  assert.equal(skipped.status, 0, skipped.stderr);
  const dry = cli(box, ['--keyless', report], {
    CONCLUSION: 'success',
    CANARY_TRACK_DRY_RUN: '1',
  });
  assert.equal(dry.status, 0, dry.stderr);

  // The dry run reads the history, and neither run writes any of it: no issue,
  // no comment, no label, so a manual run cannot pollute the alerting.
  assert.deepEqual(sequence(box.calls()), ['issue list']);
  assert.deepEqual(box.readWorld().issues, []);
  assert.match(
    readFileSync(join(box.dir, 'summary.md'), 'utf8'),
    /\| flights \| PASS \|/,
  );
});

test('a gh command the stand-in does not model fails the run instead of passing', () => {
  const box = sandbox();
  assert.throws(() => box.gh(['issue', 'close', '1']), /does not model/);
  const [call] = box.calls();
  assert.deepEqual(call.argv, ['issue', 'close', '1']);
  assert.equal(call.unsupported, true);
});

test('a gh that cannot read the history is reported, not fatal', () => {
  const box = sandbox(undefined, { withWorld: false });
  // A world file that is not JSON is what a broken gh or a bad token looks
  // like from here: the tracking read throws and the run says so.
  writeFileSync(box.state, 'not json');
  assert.throws(() => loadTracking({ gh: box.gh }), /Unexpected token|JSON/);
});
