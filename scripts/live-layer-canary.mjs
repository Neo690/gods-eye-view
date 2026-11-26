#!/usr/bin/env node
/**
 * live-layer-canary.mjs — the canary's run summary, its memory and its alerts.
 *
 * The workflow used to end with a heredoc that rendered the two reports. That
 * could only ever see one run, so a provider that had been EXTERNAL for a week
 * looked exactly like one that had been EXTERNAL for six minutes, and nothing
 * outside the run page heard about a failure.
 *
 * The canary's history now lives in one tracking issue: a human table, then a
 * hidden JSON block at the bottom of the body. Everything else is derived from
 * it, so no extra service, bucket or cache is involved:
 *
 *   - the step summary, which labels a filtered run as partial and shows each
 *     layer's previous status, the layers that broke or recovered since the
 *     previous run, and the keyed layers this run skipped with the reason (a
 *     half-configured pair names its missing variable, never a value);
 *   - the failure and recovery comments plus the `live-layer-canary-failing`
 *     label on the tracking issue.
 *
 * Escalation is deliberately not a gate change: EMPTY and EXTERNAL are
 * non-blocking because the upstream may be at fault, so a provider that returns
 * one of them for ESCALATION_THRESHOLD consecutive runs escalates to an alert,
 * never to a red run. A FAIL or MISSING layer still fails the gate itself.
 *
 * The pure half is exported for the unit test; `report` is the only command and
 * its gh calls are thin wrappers around the CLI already on the runner.
 *
 * Usage (as the canary's last step):
 *   node scripts/live-layer-canary.mjs report \
 *     --keyless qa-artifacts/keyless-live/report.json \
 *     --keyed qa-artifacts/keyed-live/report.json
 *
 * The issue path is the one part of the alerting no live run has exercised yet,
 * so `applyTracking` takes its runner as an argument and the runner honours
 * `CANARY_GH`. Either way the real create/edit/comment code runs, against a
 * stand-in instead of the GitHub API:
 *
 *   CANARY_GH=scripts/fixtures/live-layer-canary/fake-gh.mjs \
 *   FAKE_GH_STATE=/tmp/canary/issue.json GH_TOKEN=local \
 *   GITHUB_STEP_SUMMARY=/tmp/canary/summary.md \
 *     node scripts/live-layer-canary.mjs report --keyless report.json
 *
 * Exit codes: 0 report written · 1 a report could not be read at all.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TRACKING_TITLE = 'Live layer canary health';
export const TRACKING_LABEL = 'live-layer-canary';
export const FAILING_LABEL = 'live-layer-canary-failing';
export const BLOCKING_STATUSES = Object.freeze(['FAIL', 'MISSING']);
export const ESCALATING_STATUSES = Object.freeze(['EMPTY', 'EXTERNAL']);
/** Consecutive EMPTY/EXTERNAL runs before a provider becomes an alert. */
export const ESCALATION_THRESHOLD = 3;
/** Runs kept in the tracking issue; enough for a streak and a trend. */
export const HISTORY_LIMIT = 10;

const REPORT_TITLES = {
  keyless: 'Keyless live layers',
  keyed: 'Keyed live layers',
};
const TRIGGER_LABELS = {
  dispatch: 'manual dispatch',
  schedule: 'scheduled keyed run',
  full: 'nightly schedule',
};
const STATE_OPEN = '<!-- live-layer-canary-state';
const STATE_CLOSE = '-->';

/** Read one report, or null when the gate never ran or wrote nothing. */
export function readReport(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Flatten both gates' per-layer statuses into one map. */
export function summarizeReports(reports = []) {
  const layers = {};
  const failed = [];
  for (const { report } of reports) {
    if (!report) continue;
    for (const layer of report.layers ?? []) {
      const status = String(layer.status ?? 'UNKNOWN');
      layers[layer.id] = status;
      if (BLOCKING_STATUSES.includes(status)) failed.push(layer.id);
    }
  }
  return { layers, failed };
}

/** The compact record one run contributes to the history. */
export function buildRun({
  reports = [],
  selection = {},
  skipped = [],
  conclusion = 'unknown',
  url = '',
  attempt = '',
  at = new Date().toISOString(),
} = {}) {
  const outcome = summarizeReports(reports);
  return {
    at,
    url,
    attempt: attempt ? String(attempt) : '',
    conclusion,
    partial: Boolean(selection.filtered),
    layers: outcome.layers,
    failed: outcome.failed,
    skipped: skipped.map((entry) => entry.id),
  };
}

/**
 * What changed between two runs. A layer the previous run did not exercise
 * (a partial run, or a keyed layer whose credential was absent) has no before,
 * so it can break but it cannot recover.
 */
export function diffRuns(previous, current) {
  const before = previous?.layers ?? {};
  const after = current?.layers ?? {};
  const broken = [];
  const recovered = [];
  const degraded = [];
  for (const [id, status] of Object.entries(after)) {
    const was = before[id];
    if (
      BLOCKING_STATUSES.includes(status) &&
      !BLOCKING_STATUSES.includes(was)
    ) {
      broken.push({ id, status, before: was ?? null });
    }
    if (status === 'PASS' && was && was !== 'PASS') {
      recovered.push({ id, status, before: was });
    }
    if (ESCALATING_STATUSES.includes(status) && was === 'PASS') {
      degraded.push({ id, status, before: was });
    }
  }
  return { broken, recovered, degraded };
}

/**
 * Consecutive EMPTY/EXTERNAL runs for one layer, counted newest-first. A run
 * that did not exercise the layer is stepped over rather than treated as a
 * break, so a partial dispatch does not reset a real streak.
 */
export function layerStreak(runs = [], id) {
  let streak = 0;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const status = runs[index].layers?.[id];
    if (status === undefined) continue;
    if (!ESCALATING_STATUSES.includes(status)) break;
    streak += 1;
  }
  return streak;
}

/** Layers that have returned a non-PASS upstream outcome too many times running. */
export function escalatedLayers(runs = [], threshold = ESCALATION_THRESHOLD) {
  const ids = new Set(runs.flatMap((run) => Object.keys(run.layers ?? {})));
  return [...ids].filter((id) => layerStreak(runs, id) >= threshold).sort();
}

/** The hidden state block of the tracking issue, or an empty history. */
export function parseTrackingBody(body = '') {
  const match = /<!-- live-layer-canary-state\n([^\n]*)\n-->/.exec(
    String(body),
  );
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && Array.isArray(parsed.runs)) {
        return { version: 1, runs: parsed.runs };
      }
    } catch {
      // A hand-edited or truncated block starts the history over instead of
      // failing the run; the issue body is rewritten below either way.
    }
  }
  return { version: 1, runs: [] };
}

/** Append one run, keeping the history bounded. */
export function recordRun(state = { version: 1, runs: [] }, run) {
  return {
    version: 1,
    runs: [...(state.runs ?? []), run].slice(-HISTORY_LIMIT),
  };
}

/** Whether a recorded run is an alert: red, a failed layer, or a streak. */
function isFailing(run, runs, threshold = ESCALATION_THRESHOLD) {
  return (
    run.conclusion === 'failure' ||
    (run.failed ?? []).length > 0 ||
    escalatedLayers(runs, threshold).length > 0
  );
}

/**
 * Decide what this run means: the recorded history, the diff against the
 * previous run, and the alert action ('open', 'update', 'recovered', 'none').
 */
export function planTracking({ state, run, threshold = ESCALATION_THRESHOLD }) {
  const priorRuns = state?.runs ?? [];
  const previous = priorRuns.length ? priorRuns[priorRuns.length - 1] : null;
  const next = recordRun(state, run);
  const escalated = escalatedLayers(next.runs, threshold);
  const failing = isFailing(run, next.runs, threshold);
  const wasFailing = previous
    ? isFailing(previous, priorRuns, threshold)
    : false;
  const action =
    failing && !wasFailing
      ? 'open'
      : failing
        ? 'update'
        : wasFailing
          ? 'recovered'
          : 'none';
  return {
    run,
    previous,
    next,
    diff: diffRuns(previous, run),
    escalated,
    failing,
    wasFailing,
    action,
  };
}

/** Whether this plan deserves a comment, as opposed to a body refresh only. */
export function shouldComment(plan) {
  if (plan.action === 'open' || plan.action === 'recovered') return true;
  return plan.action === 'update' && plan.diff.broken.length > 0;
}

const cell = (value) =>
  String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .slice(0, 500);

const list = (ids) => ids.map((id) => `\`${id}\``).join(', ');

/**
 * The job summary. A filtered run says so first: its green result covers the
 * layers it exercised and nothing else, which is the one thing a reader of a
 * targeted canary run must not misread.
 */
export function renderSummary({
  reports = [],
  selection = {},
  plan = null,
  skipped = [],
  historyError = null,
} = {}) {
  const lines = ['## Live layer canary', ''];

  if (selection.filtered) {
    const exercised = [
      selection.keyless ? `keyless: ${selection.keyless}` : '',
      selection.only ? `keyed: ${selection.only}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    lines.push(
      `> **Partial run.** This run exercised ${exercised || 'no layer'}. The other live layers were not tested, so a green result says nothing about them.`,
      '',
    );
  }

  const trigger = TRIGGER_LABELS[selection.source ?? 'full'];
  lines.push(
    `Trigger: **${trigger}**${selection.group ? ` · concurrency group \`${selection.group}\`` : ''}`,
    '',
  );

  if (skipped.length) {
    lines.push(
      '### Keyed layers skipped',
      '',
      '| Layer | Reason |',
      '|---|---|',
      ...skipped.map(
        (entry) => `| ${cell(entry.id)} | ${cell(entry.reason)} |`,
      ),
      '',
    );
  }

  if (!reports.length) {
    lines.push(
      'No live layer report was produced: the run stopped before a gate could write one.',
      '',
    );
  }

  const previous = plan?.previous?.layers ?? {};
  for (const { mode, report } of reports) {
    if (!report) continue;
    const summary = report.summary ?? {};
    lines.push(
      `### ${REPORT_TITLES[mode] ?? mode}`,
      '',
      `Overall: **${report.ok ? 'PASS' : 'FAIL'}** (${report.strict ? 'strict' : 'non-strict'})`,
      '',
      `PASS ${summary.pass ?? 0} · EMPTY ${summary.empty ?? 0} · UNCONFIGURED ${summary.unconfigured ?? 0} · EXTERNAL ${summary.external ?? 0} · FAIL ${summary.fail ?? 0} · MISSING ${summary.missing ?? 0}`,
      '',
      '| Layer | Status | Previous | Reason |',
      '|---|---|---|---|',
      ...(report.layers ?? []).map(
        (layer) =>
          `| ${cell(layer.id)} | ${cell(layer.status)} | ${cell(previous[layer.id] ?? '—')} | ${cell(layer.reason)} |`,
      ),
      '',
    );
  }

  if (historyError) {
    lines.push(
      `> History unavailable (${cell(historyError)}): the previous run, the diff and the streaks are omitted.`,
      '',
    );
  } else if (plan?.previous) {
    const changes = [
      ...plan.diff.broken.map(
        (layer) =>
          `- :rotating_light: \`${layer.id}\` broke: ${layer.before ?? 'not run'} → ${layer.status}`,
      ),
      ...plan.diff.degraded.map(
        (layer) =>
          `- :warning: \`${layer.id}\` degraded: ${layer.before ?? 'not run'} → ${layer.status}`,
      ),
      ...plan.diff.recovered.map(
        (layer) =>
          `- :white_check_mark: \`${layer.id}\` recovered: ${layer.before} → ${layer.status}`,
      ),
    ];
    lines.push(
      '### Since the previous run',
      '',
      ...(changes.length ? changes : ['No layer changed status.']),
      '',
    );
  }

  if (plan?.escalated?.length) {
    lines.push(
      `### Escalating: ${ESCALATION_THRESHOLD}+ consecutive EMPTY/EXTERNAL runs`,
      '',
      ...plan.escalated.map(
        (id) =>
          `- \`${id}\` — ${layerStreak(plan.next.runs, id)} runs. Non-blocking by policy, but a provider that never recovers is an alert.`,
      ),
      '',
    );
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** The tracking issue body: the human table, then the hidden history. */
export function renderTrackingBody(state = { version: 1, runs: [] }) {
  const runs = state.runs ?? [];
  const latest = runs.length ? runs[runs.length - 1] : null;
  const ids = [
    ...new Set(runs.flatMap((run) => Object.keys(run.layers ?? {}))),
  ].sort();
  const lines = [
    '# Live layer canary health',
    '',
    'The live layer canary appends every completed run to this issue and comments',
    'when a run fails, recovers, or a provider keeps returning a non-PASS outcome.',
    'The hidden block at the bottom is the canary history; keep it intact.',
    '',
  ];
  if (!latest) {
    lines.push('No canary run has been recorded yet.', '');
  } else {
    lines.push(
      `Last run: ${latest.url ? `[${latest.conclusion}](${latest.url})` : latest.conclusion} · ${latest.at}${latest.partial ? ' · partial' : ''}`,
      '',
      '| Layer | Latest | Previous | EMPTY/EXTERNAL streak |',
      '|---|---|---|---|',
      ...ids.map((id) => {
        const was = runs.length > 1 ? runs[runs.length - 2].layers?.[id] : null;
        return `| ${id} | ${latest.layers?.[id] ?? '—'} | ${was ?? '—'} | ${layerStreak(runs, id)} |`;
      }),
      '',
    );
  }
  lines.push(STATE_OPEN, JSON.stringify(state), STATE_CLOSE);
  return `${lines.join('\n')}\n`;
}

/** The comment the tracking issue receives when its state changes. */
export function renderTrackingComment(plan) {
  const { run, diff, escalated, action } = plan;
  const link = run.url
    ? `[run ${run.attempt ? `${run.attempt} ` : ''}${run.at}](${run.url})`
    : run.at;
  const lines = [];
  if (action === 'recovered') {
    lines.push(`**Recovered.** The canary passed in ${link}.`, '');
    if (diff.recovered.length) {
      lines.push(
        ...diff.recovered.map(
          (layer) => `- \`${layer.id}\`: ${layer.before} → ${layer.status}`,
        ),
        '',
      );
    }
  } else {
    lines.push(
      `**Canary failing.** ${link} concluded \`${run.conclusion}\`.`,
      '',
    );
    if (run.failed.length) {
      lines.push(`Failing layers: ${list(run.failed)}`, '');
    }
    if (diff.broken.length) {
      lines.push(
        'Newly failing:',
        ...diff.broken.map(
          (layer) =>
            `- \`${layer.id}\`: ${layer.before ?? 'not run'} → ${layer.status}`,
        ),
        '',
      );
    }
    if (escalated.length) {
      lines.push(
        `EMPTY/EXTERNAL for ${ESCALATION_THRESHOLD}+ consecutive runs: ${list(escalated)}`,
        '',
      );
    }
    if (run.skipped.length) {
      lines.push(`Keyed layers skipped: ${list(run.skipped)}`, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Run one gh call and return its stdout. `CANARY_GH` names a command line to run
 * instead of `gh` (split on whitespace, so `node fake-gh.mjs` works): it is the
 * seam the tests and the local exercise use, never a runtime option.
 */
function runGh(args) {
  const override = String(process.env.CANARY_GH ?? '').trim();
  const [command, ...prefix] = override ? override.split(/\s+/) : ['gh'];
  return execFileSync(command, [...prefix, ...args], { encoding: 'utf8' });
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] ?? '') : '';
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Read the tracking issue, if the token allows it. Closed trackers are listed
 * too: a tracker someone closed by hand still holds the history, and creating a
 * second one would split it and reset the streaks. `applyTracking` reopens it
 * when the run has something to say. `gh issue list` promises an order by
 * creation, not that it survives filtering client-side, so the candidates are
 * sorted by number: the newest tracker (open first) is the one chosen.
 */
export function loadTracking({ gh = runGh } = {}) {
  const issues = JSON.parse(
    gh([
      'issue',
      'list',
      '--label',
      TRACKING_LABEL,
      '--state',
      'all',
      '--limit',
      '20',
      '--json',
      'number,title,body,state',
    ]),
  );
  const trackers = issues
    .filter((entry) => entry.title === TRACKING_TITLE)
    .sort((left, right) => right.number - left.number);
  const issue =
    trackers.find(
      (entry) => String(entry.state ?? '').toUpperCase() === 'OPEN',
    ) ??
    trackers[0] ??
    null;
  return {
    issue,
    state: issue ? parseTrackingBody(issue.body) : { version: 1, runs: [] },
  };
}

/**
 * Create the label or update it in place. `--force` makes that one idempotent
 * call: without it, every run after the first would fail on an existing label
 * and the canary would have to distinguish that failure from a real one.
 */
function setLabel(gh, name, color, description) {
  gh([
    'label',
    'create',
    name,
    '--color',
    color,
    '--description',
    description,
    '--force',
  ]);
}

/** Write the history back, open or reopen the alert, and comment if needed. */
export function applyTracking(plan, tracking, { gh = runGh } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gev-live-canary-'));
  const bodyPath = join(dir, 'body.md');
  writeFileSync(bodyPath, renderTrackingBody(plan.next));

  let number = tracking.issue?.number ?? null;
  if (number) {
    gh(['issue', 'edit', String(number), '--body-file', bodyPath]);
  } else {
    setLabel(
      gh,
      TRACKING_LABEL,
      '0e8a16',
      'Live layer canary history and alerts',
    );
    const created = gh([
      'issue',
      'create',
      '--title',
      TRACKING_TITLE,
      '--body-file',
      bodyPath,
      '--label',
      TRACKING_LABEL,
    ]).trim();
    number = Number(created.split('/').pop());
  }

  if (shouldComment(plan)) {
    // A closed tracker still accepts a comment, but nobody is notified of it;
    // a reopened one puts the alert back on the board. The state is the one the
    // lookup already read, so this costs no extra gh call.
    const open =
      String(tracking.issue?.state ?? 'OPEN').toUpperCase() === 'OPEN';
    if (!open) gh(['issue', 'reopen', String(number)]);
    const commentPath = join(dir, 'comment.md');
    writeFileSync(commentPath, renderTrackingComment(plan));
    gh(['issue', 'comment', String(number), '--body-file', commentPath]);
  }

  if (plan.failing) {
    setLabel(gh, FAILING_LABEL, 'b60205', 'The live layer canary is failing');
    gh(['issue', 'edit', String(number), '--add-label', FAILING_LABEL]);
  } else if (plan.wasFailing) {
    gh(['issue', 'edit', String(number), '--remove-label', FAILING_LABEL]);
  }
  return number;
}

function main(argv = process.argv.slice(2)) {
  const keyless = readReport(option(argv, '--keyless'));
  const keyed = readReport(option(argv, '--keyed'));
  const reports = [
    { mode: 'keyless', report: keyless },
    { mode: 'keyed', report: keyed },
  ].filter(({ report }) => report);
  if (!reports.length) {
    console.error(
      '::warning title=Live layer canary has no report::the run stopped before a gate wrote one',
    );
  }

  const skipped = parseJson(process.env.SKIPPED, []);
  const selection = {
    filtered: process.env.FILTERED === 'true',
    source: process.env.SOURCE || 'full',
    keyless: process.env.KEYLESS_ONLY || '',
    only: process.env.ONLY || '',
    group: process.env.GROUP || '',
  };
  const conclusion = process.env.CONCLUSION || 'unknown';
  const run = buildRun({
    reports,
    selection,
    skipped,
    conclusion,
    url: process.env.RUN_URL || '',
    attempt: process.env.RUN_ATTEMPT || '',
  });

  // A skipped run (the scheduled layer had no credential, or the job was
  // cancelled) is not a signal: do not rewrite history with it.
  const untracked = ['skipped', 'cancelled'].includes(conclusion);
  let plan = null;
  let historyError = null;
  let tracking = null;
  if (!untracked && process.env.GH_TOKEN) {
    try {
      tracking = loadTracking();
      plan = planTracking({ state: tracking.state, run });
    } catch (error) {
      historyError = String(error?.message || error).split('\n')[0];
    }
  }

  const summary = renderSummary({
    reports,
    selection,
    plan,
    skipped,
    historyError,
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  } else {
    process.stdout.write(summary);
  }

  for (const id of plan?.escalated ?? []) {
    console.log(
      `::warning title=Live layer ${id} not passing::${id} returned EMPTY or EXTERNAL for ${ESCALATION_THRESHOLD} consecutive runs.`,
    );
  }

  if (plan && tracking && !process.env.CANARY_TRACK_DRY_RUN) {
    try {
      const number = applyTracking(plan, tracking);
      console.log(
        `live layer canary: ${plan.action} (issue #${number}), failing=${plan.failing}`,
      );
    } catch (error) {
      console.log(
        `::warning title=Live layer canary tracking failed::${String(error?.message || error).split('\n')[0]}`,
      );
    }
  }

  // Reporting never fails the job; the gate that did the work already decided
  // the conclusion, and a missing report is itself a warning above.
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) process.exitCode = main();
