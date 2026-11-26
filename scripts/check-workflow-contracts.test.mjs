import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  WORKFLOW_DIR,
  inspectWorkflow,
  inspectWorkflowFiles,
} from './check-workflow-contracts.mjs';

const readWorkflow = (name) => readFileSync(join(WORKFLOW_DIR, name), 'utf8');

test('every workflow reference resolves', () => {
  const result = inspectWorkflowFiles();
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.reports.length >= 1);
  for (const report of result.reports) {
    assert.ok(report.jobs.length > 0, `${report.file} declares no job`);
  }
});

test('the canary reads only outputs the select job declares', () => {
  const report = inspectWorkflow(readWorkflow('live-layers.yml'), {
    file: 'live-layers.yml',
  });
  assert.equal(report.ok, true, report.errors.join('\n'));
  assert.deepEqual(report.outputs.select.sort(), [
    'filtered',
    'group',
    'keyless',
    'only',
    'skipped',
    'source',
  ]);
});

test('a needs output that no job declares is caught', () => {
  const workflow = readWorkflow('live-layers.yml').replaceAll(
    'needs.select.outputs.only',
    'needs.select.outputs.onli',
  );
  const report = inspectWorkflow(workflow, { file: 'tampered.yml' });
  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some(
      (error) =>
        error.includes('needs.select.outputs.onli') &&
        error.includes('does not declare that output'),
    ),
    report.errors.join('\n'),
  );
});

test('a reference to a job that does not exist is caught', () => {
  const workflow = readWorkflow('live-layers.yml').replaceAll(
    'needs.select.outputs.group',
    'needs.selection.outputs.group',
  );
  const report = inspectWorkflow(workflow, { file: 'tampered.yml' });
  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((error) => error.includes('no job "selection" exists')),
    report.errors.join('\n'),
  );
});

test('a step output from an undefined step is caught', () => {
  const workflow = readWorkflow('live-layers.yml').replaceAll(
    'steps.selection.outputs.group',
    'steps.selections.outputs.group',
  );
  const report = inspectWorkflow(workflow, { file: 'tampered.yml' });
  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some(
      (error) =>
        error.includes('steps.selections') &&
        error.includes('no step with that id'),
    ),
    report.errors.join('\n'),
  );
});

test('a job that needs a job that does not exist is caught', () => {
  const workflow = readWorkflow('live-layers.yml').replace(
    '    needs: select',
    '    needs: selected',
  );
  const report = inspectWorkflow(workflow, { file: 'tampered.yml' });
  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((error) => error.includes('needs "selected"')),
    report.errors.join('\n'),
  );
});
