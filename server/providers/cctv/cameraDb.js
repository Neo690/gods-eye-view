import fs from 'node:fs';
import path from 'node:path';

/** Sidecar written by scripts/build-cctv-camera-models.mjs. */
export const DEFAULT_CAMERA_MODELS_FILE =
  'src/data/local_data/cctv_camera_models/cctv_camera_models.json';

/**
 * @typedef {object} CameraModelsDb
 * @property {Map<string, Array<{brand: string, model: string, id: string}>>} lookup
 * @property {Map<string, Array<{brand: string, model: string, id: string}>>} series
 *   First series token → entries whose model names a longer title after it
 *   ("3950" → "3950 iVIEW").
 * @property {Set<string>} brandNorm Normalized brand names.
 * @property {{source: string, license: string, cameraCount: number}} meta
 */

/** @type {{path: string, mtimeMs: number, db: CameraModelsDb|null}|null} */
let _cache = null;

/**
 * Load the committed camera-model index (CC0 ch-bas/cctv-camera-database,
 * reduced to brand/model/id). Missing, stale or malformed files mean "no
 * database" — the join is skipped, never an error.
 * @param {string} sourceRoot
 * @returns {CameraModelsDb|null} null when no usable index is installed.
 */
export function loadCameraModels(sourceRoot = process.cwd()) {
  const file =
    process.env.CCTV_CAMERA_MODELS_FILE || DEFAULT_CAMERA_MODELS_FILE;
  const resolved = path.isAbsolute(file)
    ? file
    : path.resolve(sourceRoot, file);
  try {
    const stat = fs.statSync(resolved);
    if (_cache && _cache.path === resolved && _cache.mtimeMs === stat.mtimeMs) {
      return _cache.db;
    }
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.lookup !== 'object'
    ) {
      throw new Error('no lookup');
    }
    const lookup = new Map();
    for (const [key, entries] of Object.entries(parsed.lookup || {})) {
      const valid = (Array.isArray(entries) ? entries : []).filter(
        (entry) => entry && entry.brand && entry.model && entry.id,
      );
      if (valid.length) lookup.set(key, valid);
    }
    const series = new Map();
    for (const [key, entries] of Object.entries(parsed.series || {})) {
      const valid = (Array.isArray(entries) ? entries : []).filter(
        (entry) => entry && entry.brand && entry.model && entry.id,
      );
      if (valid.length) series.set(key, valid);
    }
    /** @type {CameraModelsDb} */
    const db = {
      lookup,
      series,
      brandNorm: new Set(
        Array.isArray(parsed.brandNorm) ? parsed.brandNorm : [],
      ),
      meta: {
        source: String(parsed.source || 'ch-bas/cctv-camera-database'),
        license: String(parsed.license || 'CC0-1.0'),
        cameraCount: Number(parsed.cameraCount) || 0,
      },
    };
    _cache = { path: resolved, mtimeMs: stat.mtimeMs, db };
    return db;
  } catch {
    _cache = null;
    return null;
  }
}

/** Lowercase, collapse every non-alphanumeric run to one space, trim. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The index only confirms hardware it writes down unambiguously: an
 * ambiguous key (several brands make a "PTZ", several cameras a "3960")
 * confirms nothing, and a candidate under 3 characters ("P9", a bare "HD")
 * is too collision-prone to name a model.
 * @param {Array<object>} entries
 * @param {string} candidate
 * @returns {object|null} {brand, model, id, match} or null.
 */
function resolveEntry(entries, candidate, match) {
  if (!candidate || candidate.length < 3) return null;
  const list = entries && entries.length === 1 ? entries : null;
  if (!list) return null;
  const entry = list[0];
  return { ...entry, match };
}

/**
 * Match one catalog entry's hardware strings against the committed index.
 *
 * Feeds write the pair in their own dialect: "Cohu 3950" (brand joined to
 * the series), "AUTODOME IP 4000 HD" (brand in the manufacturer column),
 * "3950 iVIEW" (the dataset's own model text). The match is the model only:
 * the feed's `model` string is never rewritten by a match — a confirmed
 * match can fill a missing `manufacturer`, attach the dataset row id, and
 * name how confident the match is. Nothing matches from a camera's place
 * name, and a model the dataset does not list stays exactly as the feed
 * published it.
 *
 * @param {CameraModelsDb|null} db The loaded index (null: no match possible).
 * @param {string} modelString The entry's own `model` (already whitespace-
 *   collapsed where the pack publishes one).
 * @returns {{brand: string, model: string, id: string, match: string}|null}
 *   `match` is 'exact' (the whole string, brand prefix removed) or 'series'
 *   (a `3950` naming the `3950 iVIEW` the dataset lists with the same
 *   leading series number).
 */
export function matchCameraModel(db, modelString) {
  if (!db || !modelString) return null;
  const text = normalize(modelString);
  if (!text) return null;

  // Peel leading brand names off ("Cohu 3950" → "3950"; a multi-word brand
  // like "TelaVision Works" peels as one unit), longest run first, while
  // words remain to match a model against.
  const words = text.split(' ');
  let brandWords = 0;
  while (brandWords < words.length - 1) {
    let peeled = 0;
    for (let k = Math.min(3, words.length - 1 - brandWords); k >= 1; k--) {
      if (db.brandNorm.has(words.slice(brandWords, brandWords + k).join(' '))) {
        peeled = k;
        break;
      }
    }
    if (!peeled) break;
    brandWords += peeled;
  }
  const peelTokens = words.slice(0, brandWords);
  const stripped = brandWords ? words.slice(brandWords).join(' ') : text;

  // A string that names a brand limits the match to that brand's hardware:
  // "AXIS Q61" must not land on another maker's "Q61" even though the bare
  // remainder resolves. Every word of the row's brand must have been part of
  // the peel.
  const brandAgrees = (entry) =>
    !brandWords ||
    normalize(entry.brand)
      .split(' ')
      .every((token) => peelTokens.includes(token));

  const exact = resolveEntry(db.lookup.get(stripped), stripped, 'exact');
  if (exact) return brandAgrees(exact) ? exact : null;

  // Series tier: the full string never names one dataset row, but its first
  // token may be the series number the dataset writes a longer title after
  // ("3950" → "3950 iVIEW"). The token must contain a digit and pass the
  // length gate, so an "auto" or "pro" prefix never names a whole family.
  const first = stripped.split(' ')[0];
  const series = resolveEntry(db.series.get(first), first, 'series');
  return series && brandAgrees(series) ? series : null;
}

/**
 * Attach dataset-backed hardware facts to catalog entries that publish their
 * own `model`: `manufacturer` only when the entry has none, plus `modelRef`
 * (the dataset row id) and `modelMatch` ('exact'|'series') for traceability.
 * Everything a pack published is left as-is — the join adds, never corrects,
 * so a feed's own strings stay its own words.
 *
 * @param {Array<object>} sources - Normalized served sources.
 * @param {CameraModelsDb|null} db The loaded index (null: a no-op).
 * @returns {Array<object>} The same sources.
 */
export function joinCameraModels(sources, db) {
  if (!db || !sources || typeof sources !== 'object') return sources;
  for (const source of sources) {
    if (!source?.model || source.modelRef) continue;
    const match = matchCameraModel(db, source.model);
    if (!match) continue;
    source.modelRef = match.id;
    source.modelMatch = match.match;
    if (
      typeof source.manufacturer !== 'string' ||
      !source.manufacturer.trim()
    ) {
      source.manufacturer = match.brand;
    }
  }
  return sources;
}
