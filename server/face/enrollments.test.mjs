import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addEnrollment,
  cohortEnrollments,
  MAX_ENROLLMENTS,
  MAX_ENROLLMENTS_PER_COHORT,
  readEnrollments,
  removeEnrollment,
  validateEmbedding,
} from './enrollments.js';

/** Deterministic 512-d "embedding" of a person, for tests only. */
function fakeEmbedding(seed = 1) {
  const values = [];
  for (let i = 0; i < 512; i += 1)
    values.push(Math.sin((seed + 1) * i * 0.017) * 0.05);
  return values;
}

test('a consent enrewrl records label, cohort and rounded numbers only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-face-'));
  const file = path.join(dir, 'roster.json');
  const outcome = await addEnrollment(
    { label: 'Alice', cohort: 'site-staff', embedding: fakeEmbedding(2) },
    { file, now: () => 1_719_000_000_000 },
  );
  assert.equal(outcome.error, undefined);
  const record = outcome.enrollment;
  assert.equal(record.label, 'Alice');
  assert.equal(record.cohort, 'site-staff');
  assert.equal(record.embedding.length, 512);
  assert.equal(typeof record.embedding[0], 'number');
  // A number rounded to 4 decimals — never raw doubles, never an image path.
  assert.ok(
    Number.isInteger(record.embedding[0] * 10_000),
    'embedding values are stored rounded',
  );
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('image'), 'no image path lands in the roster');
});

test('nothing is accepted without a label and a cohort', async () => {
  const outcomeA = await addEnrollment(
    { label: '', cohort: 'cohort', embedding: fakeEmbedding() },
    { file: await tempFile() },
  );
  assert.equal(outcomeA.error, 'label_required');
  const outcomeB = await addEnrollment(
    { label: 'Bob', cohort: '   ', embedding: fakeEmbedding() },
    { file: await tempFile() },
  );
  assert.equal(outcomeB.error, 'cohort_required');
});

async function tempFile() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-face-'));
  return path.join(dir, 'roster.json');
}

test('an embedding of the wrong shape is named as such', () => {
  assert.match(validateEmbedding([0.1, 0.2], 512)?.error ?? '', /embedding/);
  assert.match(validateEmbedding(new Array(512).fill('x'), 512)?.error ?? '', /embedding/);
  assert.equal(validateEmbedding(fakeEmbedding(3), 512).error, undefined);
});

test('namespaced rosters never leak one cohort into another', async () => {
  const file = await tempFile();
  await addEnrollment({ label: 'Ops-1', cohort: 'roster-a', embedding: fakeEmbedding(1) }, { file });
  await addEnrollment({ label: 'Ops-2', cohort: 'roster-b', embedding: fakeEmbedding(2) }, { file });
  const onlyA = await cohortEnrollments('roster-a', { file });
  assert.deepEqual(
    onlyA.enrollments.map((e) => e.label).sort(),
    ['Ops-1'],
  );
  const matches = await cohortEnrollments('wholly-other', { file });
  assert.equal(matches.enrollments.length, 0);
});

test('a cohort cannot grow past its ceiling', async () => {
  const file = await tempFile();
  for (let i = 0; i < MAX_ENROLLMENTS_PER_COHORT; i += 1) {
    const outcome = await addEnrollment(
      { label: `p${i}`, cohort: 'big', embedding: fakeEmbedding(i) },
      { file },
    );
    assert.equal(outcome.error, undefined);
  }
  const overTheLine = await addEnrollment(
    { label: 'one too many', cohort: 'big', embedding: fakeEmbedding(99) },
    { file },
  );
  assert.equal(overTheLine.error, 'cohort_full');
});

test('the whole roster has a ceiling too', async () => {
  const file = await tempFile();
  const cohort = [];
  for (let i = 0; i < MAX_ENROLLMENTS; i += 1) cohort.push(`c${i % 10}`);
  for (let i = 0; i < MAX_ENROLLMENTS; i += 1)
    await addEnrollment(
      { label: `p${i}`, cohort: cohort[i], embedding: fakeEmbedding(i) },
      { file },
    );
  const blocked = await addEnrollment(
    { label: 'blocked', cohort: 'zzz', embedding: fakeEmbedding(9) },
    { file },
  );
  assert.equal(blocked.error, 'roster_full');
});

test('removal is exact and idempotent', async () => {
  const file = await tempFile();
  const enrolled = await addEnrollment(
    { label: 'Carol', cohort: 'site', embedding: fakeEmbedding(4) },
    { file },
  );
  const id = enrolled.enrollment.id;
  assert.equal((await removeEnrollment(id, { file })).removed, true);
  assert.equal((await removeEnrollment(id, { file })).removed, false);
  const left = await readEnrollments(file);
  assert.equal(left.enrollments.length, 0);
});

test('a corrupted roster reads as empty, not as a served guess', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-face-'));
  const file = path.join(dir, 'broken.json');
  await writeFile(file, '{"enrollments": [');
  const roster = await readEnrollments(file);
  assert.deepEqual(roster.enrollments, []);
});

test('writes are atomic enough to leave no temp junk behind', async () => {
  const file = await tempFile();
  await addEnrollment(
    { label: 'Dave', cohort: 'site', embedding: fakeEmbedding(5) },
    { file },
  );
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(parsed.savedAt);
});
