/**
 * The enrollment roster: the only base face matching is allowed to compare
 * against.
 *
 * This is base ferme opt-in, deliberately the opposite of the identification
 * lookups this feature is not: a person is enrolled because they were asked and
 * said yes, the embedding is the only thing that leaves their photo, and the
 * photo itself is never stored — the server keeps 512 numbers and a label, and
 * discards the pixels at the end of the request.
 *
 * Storage is a small JSON file under `GEV_FACE_ENROLLMENTS_DIR` (or the
 * repository-local server data directory), rewritten atomically. Numbers are
 * rounded to 4 decimals on the way in: a 512-d embedding keeps its cosine
 * distances well below the match threshold at that precision, and the file
 * stays readable and diffable.
 *
 * Cohorts bound the answer: a match request names the cohort it may see — the
 * site's own staff, its subscribers — and nothing outside it is ever compared.
 * @module server/face/enrollments
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Roster ceiling, so one file cannot grow into a biometric database. */
export const MAX_ENROLLMENTS = 200;

/** Cohort ceiling: each cohort is small by definition. */
export const MAX_ENROLLMENTS_PER_COHORT = 50;

/** Limits on what a caller may name things. */
export const LABEL_MAX_CHARS = 80;
export const COHORT_MAX_CHARS = 64;

/** Rounding kept in the file: cosine distance is preserved at far past this. */
export const EMBEDDING_DECIMALS = 4;

/** Where the roster lives by default (the repo keeps server data beside /tmp). */
export function enrollmentsDirectory(env = process.env) {
  const override = String(env?.GEV_FACE_ENROLLMENTS_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(process.cwd(), '.gev-data', 'face');
}

/** Full path of the roster file for a base name. */
export function enrollmentsFile(baseName = 'roster', env = process.env) {
  return path.join(enrollmentsDirectory(env), `${baseName}.json`);
}

/** Read the roster, or an empty one when the file does not exist yet. */
export async function readEnrollments(
  file = enrollmentsFile(),
  { embeddingLengths = new Set() } = {},
) {
  let raw = null;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { enrollments: [] };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupted roster is replaced, not served: an unreadable one must not
    // silently produce matches (or drop cohorts) at match time.
    return { enrollments: [] };
  }
  const enrollments = Array.isArray(parsed?.enrollments)
    ? parsed.enrollments.filter(
        (e) =>
          e &&
          typeof e.id === 'string' &&
          typeof e.label === 'string' &&
          typeof e.cohort === 'string' &&
          Array.isArray(e.embedding) &&
          e.embedding.every((v) => typeof v === 'number' && isFinite(v)) &&
          (!embeddingLengths.size || embeddingLengths.has(e.embedding.length)),
      )
    : [];
  return { enrollments, savedAt: parsed?.savedAt ?? null };
}

/** Write the roster atomically: temp file beside it, then rename over. */
async function writeEnrollments(enrollments, file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload = JSON.stringify(
    { savedAt: new Date().toISOString(), enrollments },
    null,
    2,
  );
  const tempFile = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, `${payload}\n`, 'utf8');
  await fs.rename(tempFile, file);
}

/** A stable, unguessable-looking id; anything the user types can be a label. */
function newId(now = Date.now) {
  return `f${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Validate and normalize one enrollment request's label and cohort. */
function validateNames({ label, cohort }) {
  const trimmedLabel = String(label ?? '').trim();
  const trimmedCohort = String(cohort ?? '').trim();
  if (!trimmedLabel)
    return { error: 'label_required', message: 'An enrolled person needs a label' };
  if (trimmedLabel.length > LABEL_MAX_CHARS)
    return { error: 'label_too_long', message: `Label exceeds ${LABEL_MAX_CHARS} characters` };
  if (!trimmedCohort)
    return { error: 'cohort_required', message: 'An enrollment needs a cohort' };
  if (trimmedCohort.length > COHORT_MAX_CHARS)
    return { error: 'cohort_too_long', message: `Cohort exceeds ${COHORT_MAX_CHARS} characters` };
  return { label: trimmedLabel, cohort: trimmedCohort };
}

/** Validate one embedding: finite numbers, bounded length, non-zero. */
export function validateEmbedding(embedding, expectedLength = 512) {
  if (!Array.isArray(embedding) && !(embedding instanceof Float32Array))
    return { error: 'embedding_invalid', message: 'An embedding is required' };
  const values = Array.from(embedding ?? []);
  if (values.length !== expectedLength)
    return {
      error: 'embedding_invalid',
      message: `The embedding must have ${expectedLength} numbers`,
    };
  if (values.some((v) => typeof v !== 'number' || !isFinite(v)))
    return { error: 'embedding_invalid', message: 'Embedding values must be finite' };
  const norm = Math.sqrt(values.reduce((acc, v) => acc + v * v, 0));
  if (!(norm > 0))
    return { error: 'embedding_invalid', message: 'The embedding must not be all zeros' };
  return {
    embedding: values.map((v) => Number(v.toFixed(EMBEDDING_DECIMALS))),
    norm,
  };
}

/**
 * Add one person, after the caller's own consent gate. Returns the stored
 * record — with the embedding in it, so the route can hand back only the
 * metadata.
 *
 * @param {{label:string, cohort:string, embedding:Float32Array|number[],
 *   note?:string}} request
 * @param {{file?:string, embeddingLength?:number, now?:Function}} [options]
 */
export async function addEnrollment(
  { label, cohort, embedding, note },
  { file = enrollmentsFile(), embeddingLength = 512, now = Date.now } = {},
) {
  const names = validateNames({ label, cohort });
  if (names.error) return names;
  const checked = validateEmbedding(embedding, embeddingLength);
  if (checked.error) return checked;
  const { enrollments } = await readEnrollments(file);
  if (enrollments.length >= MAX_ENROLLMENTS)
    return {
      error: 'roster_full',
      message: `The roster is capped at ${MAX_ENROLLMENTS}`,
    };
  const inCohort = enrollments.filter((e) => e.cohort === names.cohort);
  if (inCohort.length >= MAX_ENROLLMENTS_PER_COHORT)
    return {
      error: 'cohort_full',
      message: `A cohort is capped at ${MAX_ENROLLMENTS_PER_COHORT}`,
    };
  const record = {
    id: newId(now),
    label: names.label,
    cohort: names.cohort,
    embedding: checked.embedding,
    note: typeof note === 'string' ? note.slice(0, LABEL_MAX_CHARS) : '',
    createdAt: new Date(now()).toISOString(),
  };
  enrollments.push(record);
  await writeEnrollments(enrollments, file);
  return { enrollment: record };
}

/** Remove by id; `{removed}` answers, and false when the id was not there. */
export async function removeEnrollment(id, { file = enrollmentsFile() } = {}) {
  if (typeof id !== 'string' || !id) return { error: 'id_required' };
  const { enrollments } = await readEnrollments(file);
  const next = enrollments.filter((e) => e.id !== id);
  if (next.length === enrollments.length) return { removed: false };
  await writeEnrollments(next, file);
  return { removed: true };
}

/** Everything one cohort may see, embeddings included for the comparer. */
export async function cohortEnrollments(
  cohort,
  { file = enrollmentsFile() } = {},
) {
  const trimmed = String(cohort ?? '').trim();
  if (!trimmed)
    return { error: 'cohort_required', message: 'A match needs a cohort' };
  const { enrollments } = await readEnrollments(file);
  return { enrollments: enrollments.filter((e) => e.cohort === trimmed) };
}
