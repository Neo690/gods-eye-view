#!/usr/bin/env node
/**
 * check-workflow-contracts.mjs — the references a workflow makes to itself.
 *
 * Every `needs.select.outputs.group` and `steps.keys.outputs.present` in a
 * workflow is a string until Actions evaluates it.
 *
 * It deliberately does not judge action pinning or permissions: those are
 * policies a review sets, not references that can dangle, and enforcing them
 * here would fail the suite for another change's workflow. A rename or a typo therefore
 * compiles, lints as YAML, and fails at the moment the canary needs it — after
 * an install, a build and a browser launch, or not at all when the reference
 * sits in a step that only runs on failure. actionlint catches most of that
 * from the real Actions schema; this catches the rest in the unit suite, where
 * a rename is a red test rather than a nightly surprise.
 *
 * It is a line scan, not a YAML parser: it understands the shapes this
 * repository uses (two-space job keys, four-space job fields, six-space step
 * lists, `needs:` as a scalar, an inline array or a block list) and nothing
 * else. Anything it cannot classify is skipped rather than guessed at.
 *
 * Usage:
 *   node scripts/check-workflow-contracts.mjs            # check every workflow
 *   node scripts/check-workflow-contracts.mjs --check    # same
 *
 * Exit codes: 0 every reference resolved · 1 a dangling or unsafe reference.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKFLOW_DIR = resolve(HERE, '../.github/workflows');

const JOB_KEY = /^ {2}([A-Za-z0-9_-]+):\s*$/;
const JOB_FIELD = /^ {4}([A-Za-z0-9_-]+):/;

/**
 * Collect the jobs, outputs, step ids and references of one workflow.
 *
 * Returns `{ ok, errors, jobs }`; `errors` names the line so a failure points
 * at the reference, not at the file.
 */
export function inspectWorkflow(source, { file = 'workflow' } = {}) {
  const errors = [];
  const jobs = new Map();
  const needsRefs = [];
  const needTargets = [];
  const stepRefs = [];

  let job = null;
  let inJobs = false;
  let inOutputs = false;
  let inNeeds = false;

  const lines = String(source).split('\n');
  for (const [index, raw] of lines.entries()) {
    const at = index + 1;
    const line = raw.replace(/\s+#\s.*$/, '');
    if (!line.trim() || /^\s*#/.test(line)) continue;

    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      job = null;
      inOutputs = false;
      inNeeds = false;
      continue;
    }
    if (/^\S/.test(line)) {
      // Any other top-level key ends the jobs block.
      inJobs = false;
      job = null;
      continue;
    }
    if (!inJobs) continue;

    // References are collected before the structural branches below, because a
    // job-level `outputs:` entry is itself a `steps.<id>.outputs.<name>`
    // reference. On a job header line `job` is still the previous job, but a
    // header never carries a reference.
    for (const ref of line.matchAll(
      /needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g,
    )) {
      needsRefs.push({
        at,
        job: ref[1],
        output: ref[2],
        from: job?.name ?? '-',
      });
    }
    for (const ref of line.matchAll(
      /needs\.([A-Za-z0-9_-]+)\.(?:result|outputs)\b/g,
    )) {
      needTargets.push({ at, name: ref[1], from: job?.name ?? '-' });
    }
    for (const ref of line.matchAll(
      /steps\.([A-Za-z0-9_-]+)\.(?:outputs|outcome|conclusion)\b/g,
    )) {
      stepRefs.push({ at, name: ref[1], from: job?.name ?? '-' });
    }

    const jobKey = JOB_KEY.exec(line);
    if (jobKey) {
      if (jobs.has(jobKey[1])) {
        errors.push(`${file}:${at}: duplicate job "${jobKey[1]}"`);
      }
      job = {
        name: jobKey[1],
        ids: new Set(),
        outputs: new Set(),
        needs: new Set(),
      };
      jobs.set(job.name, job);
      inOutputs = false;
      inNeeds = false;
      continue;
    }
    if (!job) continue;

    const needsField = /^ {4}needs:\s*(.+?)\s*$/.exec(line);
    if (needsField) {
      const value = needsField[1];
      if (value.startsWith('[')) {
        for (const entry of value.replace(/^\[|\]$/g, '').split(',')) {
          const name = entry.trim().replace(/^['"]|['"]$/g, '');
          if (name) job.needs.add(name);
        }
      } else {
        job.needs.add(value.replace(/^['"]|['"]$/g, ''));
      }
      inNeeds = false;
      inOutputs = false;
      continue;
    }
    if (/^ {4}needs:\s*$/.test(line)) {
      inNeeds = true;
      inOutputs = false;
      continue;
    }
    if (inNeeds) {
      const item = /^ {6}-\s*([A-Za-z0-9_-]+)\s*$/.exec(line);
      if (item) {
        job.needs.add(item[1]);
        continue;
      }
      inNeeds = false;
    }

    if (/^ {4}outputs:\s*$/.test(line)) {
      inOutputs = true;
      continue;
    }
    if (inOutputs) {
      const entry = /^ {6}([A-Za-z0-9_-]+):/.exec(line);
      if (entry) {
        job.outputs.add(entry[1]);
        continue;
      }
      inOutputs = false;
    }

    const stepId = /^ {8}id:\s*([A-Za-z0-9_-]+)\s*$/.exec(line);
    if (stepId) {
      if (job.ids.has(stepId[1])) {
        errors.push(
          `${file}:${at}: duplicate step id "${stepId[1]}" in job "${job.name}"`,
        );
      }
      job.ids.add(stepId[1]);
    }
  }

  for (const ref of needsRefs) {
    const target = jobs.get(ref.job);
    if (!target) {
      errors.push(
        `${file}:${ref.at}: "${ref.from}" reads needs.${ref.job}.outputs.${ref.output}, but no job "${ref.job}" exists`,
      );
    } else if (!target.outputs.has(ref.output)) {
      errors.push(
        `${file}:${ref.at}: "${ref.from}" reads needs.${ref.job}.outputs.${ref.output}, but "${ref.job}" does not declare that output`,
      );
    }
  }
  for (const ref of needTargets) {
    if (!jobs.has(ref.name)) {
      errors.push(
        `${file}:${ref.at}: "${ref.from}" depends on "needs.${ref.name}", but no job "${ref.name}" exists`,
      );
    }
  }
  for (const ref of stepRefs) {
    const owner = jobs.get(ref.from);
    if (owner && !owner.ids.has(ref.name)) {
      errors.push(
        `${file}:${ref.at}: "${ref.from}" reads steps.${ref.name}, but that job has no step with that id`,
      );
    }
  }
  for (const [name, entry] of jobs) {
    for (const target of entry.needs) {
      if (target === name) {
        errors.push(`${file}: job "${name}" lists itself in needs`);
      } else if (!jobs.has(target)) {
        errors.push(
          `${file}: job "${name}" needs "${target}", but no such job exists`,
        );
      }
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    jobs: [...jobs.keys()],
    outputs: Object.fromEntries(
      [...jobs].map(([name, entry]) => [name, [...entry.outputs]]),
    ),
  };
}

export function inspectWorkflowFiles(dir = WORKFLOW_DIR) {
  const files = readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  const reports = files.map((name) => ({
    file: `.github/workflows/${name}`,
    ...inspectWorkflow(readFileSync(join(dir, name), 'utf8'), {
      file: `.github/workflows/${name}`,
    }),
  }));
  const errors = reports.flatMap((report) => report.errors);
  return { ok: errors.length === 0, errors, reports };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length && !argv.includes('--check')) {
    console.error('usage: node scripts/check-workflow-contracts.mjs [--check]');
    return 1;
  }
  const result = inspectWorkflowFiles();
  if (!result.ok) {
    for (const error of result.errors) console.error(error);
    return 1;
  }
  console.log(
    `workflow contracts: ${result.reports.length} workflows, every needs and steps reference resolves`,
  );
  return 0;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) process.exitCode = main();
