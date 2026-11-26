#!/usr/bin/env node
/**
 * A stand-in for `gh` that covers exactly the commands the live layer canary's
 * tracking step uses, so `create/edit/comment/reopen/label` run for real rather
 * than being assumed.
 *
 * It keeps a tiny issue world in a JSON file instead of talking to GitHub:
 *
 *   FAKE_GH_STATE        the world file (created empty when missing)   required
 *   FAKE_GH_TRANSCRIPT   one JSON record per call (default: <state>.jsonl)
 *
 * Every call is appended to the transcript as `{ argv }`, so a test can assert
 * the exact sequence of gh calls a run made. A command this fake does not model
 * is refused with exit 1 and a record marked `unsupported`, which is what keeps
 * the canary from drifting onto a gh call nobody has exercised.
 *
 * The world shape is `{ nextNumber, issues: [{ number, title, body, state,
 * labels, comments }], labels: [{ name, color, description }] }`.
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

const argv = process.argv.slice(2);
const statePath = process.env.FAKE_GH_STATE;
const transcriptPath =
  process.env.FAKE_GH_TRANSCRIPT || `${statePath || '/dev/null'}.jsonl`;

function record(entry) {
  appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`);
}

function fail(message, entry = {}) {
  record({ argv, ...entry });
  process.stderr.write(`gh: ${message}\n`);
  process.exit(1);
}

if (!statePath) {
  // No world to write to: still refuse before anything is recorded as supported.
  process.stderr.write('gh: FAKE_GH_STATE is not set\n');
  process.exit(1);
}

const world = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, 'utf8'))
  : {};
world.nextNumber ??= 1;
world.issues ??= [];
world.labels ??= [];

const save = () =>
  writeFileSync(statePath, `${JSON.stringify(world, null, 2)}\n`);
const url = (issue) =>
  `https://github.com/fake/gods-eye-view/issues/${issue.number}`;

function valueOf(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function valuesOf(flag) {
  return argv.flatMap((arg, index) =>
    arg === flag && argv[index + 1] !== undefined ? [argv[index + 1]] : [],
  );
}

function bodyFromFile() {
  const path = valueOf('--body-file');
  return path ? readFileSync(path, 'utf8') : '';
}

/** The issue an `edit`, `view`, `reopen` or `comment` names. */
function target() {
  const rest = argv.slice(2);
  const number = Number(rest.find((arg) => /^\d+$/.test(arg)));
  const issue = world.issues.find((entry) => entry.number === number);
  if (!issue) fail(`no issue #${number}`);
  return issue;
}

function list() {
  const label = valueOf('--label');
  const state = String(valueOf('--state') ?? 'open').toUpperCase();
  const fields = String(valueOf('--json') ?? 'number,title,body').split(',');
  const issues = world.issues
    .filter((issue) => state === 'ALL' || issue.state === state)
    .filter((issue) => !label || issue.labels.includes(label))
    .map((issue) =>
      Object.fromEntries(fields.map((field) => [field, issue[field] ?? null])),
    );
  record({ argv });
  process.stdout.write(`${JSON.stringify(issues)}\n`);
}

function create() {
  const issue = {
    number: world.nextNumber,
    title: String(valueOf('--title') ?? ''),
    body: bodyFromFile(),
    state: 'OPEN',
    labels: valuesOf('--label'),
    comments: [],
  };
  world.nextNumber += 1;
  world.issues.push(issue);
  save();
  record({ argv, issue: issue.number });
  process.stdout.write(`${url(issue)}\n`);
}

function edit() {
  const issue = target();
  if (argv.includes('--body-file')) issue.body = bodyFromFile();
  for (const label of valuesOf('--add-label')) {
    if (!issue.labels.includes(label)) issue.labels.push(label);
  }
  for (const label of valuesOf('--remove-label')) {
    issue.labels = issue.labels.filter((entry) => entry !== label);
  }
  save();
  record({ argv, issue: issue.number });
  process.stdout.write(`${url(issue)}\n`);
}

function reopen() {
  const issue = target();
  issue.state = 'OPEN';
  save();
  record({ argv, issue: issue.number });
  process.stdout.write(`${url(issue)}\n`);
}

function comment() {
  const issue = target();
  issue.comments.push({ body: bodyFromFile() });
  save();
  record({ argv, issue: issue.number, comments: issue.comments.length });
  process.stdout.write(`${url(issue)}#issuecomment-${issue.comments.length}\n`);
}

function createLabel() {
  const name = argv[2];
  const label = {
    name,
    color: String(valueOf('--color') ?? ''),
    description: String(valueOf('--description') ?? ''),
  };
  const existing = world.labels.findIndex((entry) => entry.name === name);
  if (existing >= 0 && !argv.includes('--force')) {
    // `gh` refuses this too, which is why the canary passes --force.
    fail(`label "${name}" already exists`, { status: 'existing-label' });
  }
  if (existing >= 0) world.labels[existing] = label;
  else world.labels.push(label);
  save();
  record({ argv });
  process.stdout.write(`${name}\n`);
}

const [group, command] = argv;
const handlers = {
  'issue list': list,
  'issue create': create,
  'issue edit': edit,
  'issue reopen': reopen,
  'issue comment': comment,
  'label create': createLabel,
};
const handler = handlers[`${group} ${command}`];
if (!handler) {
  fail(`this fake does not model: gh ${argv.join(' ')}`, { unsupported: true });
}
handler();
