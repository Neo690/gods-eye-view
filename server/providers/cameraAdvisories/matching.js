/**
 * The join between published advisories and catalogued cameras.
 *
 * Pure functions only: no network, no clock, no filesystem. A camera is
 * flagged only when an advisory names its product line — never because its
 * brand happens to publish advisories for other products. That distinction is
 * the whole safety of the feature: a brand-level match says nothing about the
 * camera in the field, so it is reported as context, not as a finding.
 */

import {
  CAMERA_BRANDS,
  MAX_MATCHES_PER_CAMERA,
  SEVERITY_BANDS,
  SEVERITY_RANK,
} from './constants.js';

/** Lowercase, every non-alphanumeric run to one space, trimmed. */
export function normalizeWords(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Lowercase alphanumerics only — the shape CPE products use. */
export function compact(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Whether `alias` occurs in `words` as a whole phrase. */
function hasPhrase(words, alias) {
  if (!alias) return false;
  return ` ${words} `.includes(` ${alias} `);
}

/**
 * Canonical camera brand for a manufacturer string, or null.
 *
 * Catalogue feeds write the manufacturer in their own words ("Hanwha Techwin",
 * "BOSCH"); the alias table maps those onto the small vocabulary NVD uses.
 * An unknown brand is deliberately not guessed at.
 *
 * @param {string} text
 * @returns {string|null} canonical brand id
 */
export function brandFor(text) {
  const words = normalizeWords(text);
  if (!words) return null;
  for (const brand of CAMERA_BRANDS) {
    if (brand.aliases.some((alias) => hasPhrase(words, alias))) {
      return brand.id;
    }
  }
  return null;
}

/** The canonical brand record for an id, or null. */
export function brandRecord(id) {
  return CAMERA_BRANDS.find((brand) => brand.id === id) ?? null;
}

/**
 * A camera's hardware identity, or null when the catalogue did not publish
 * both halves. A model without a brand (or the reverse) is not a join key:
 * half an identity would produce matches nobody can check.
 *
 * @param {{manufacturer?:string, brand?:string, model?:string}} camera
 * @returns {{brand:string, model:string}|null}
 */
export function cameraHardware(camera) {
  const manufacturer = String(
    camera?.manufacturer ?? camera?.brand ?? '',
  ).trim();
  const model = String(camera?.model ?? '').trim();
  if (!manufacturer || !model) return null;
  const brand = brandFor(manufacturer);
  if (!brand) return null;
  return { brand, model };
}

/**
 * Matching keys for one model.
 *
 * `modelKey` is the compact model as the feed wrote it, minus a brand prefix
 * ("AXIS P3707-PE" → "p3707pe"). `seriesKey` is the first model segment that
 * carries a digit — "DS-2CD2087G3-LI2UY" → "2cd2087g3", "Q6135-LE" → "q6135"
 * — which catches advisories that name the family rather than one variant.
 *
 * @param {string} model
 * @param {string} [brandId]
 * @returns {{modelKey:string, seriesKey:string}}
 */
export function modelKeys(model, brandId = '') {
  const brand = brandId ? brandRecord(brandId) : null;
  let key = compact(model);
  for (const alias of brand?.aliases ?? []) {
    const prefix = compact(alias);
    if (prefix && key.startsWith(prefix) && key.length > prefix.length) {
      key = key.slice(prefix.length);
      break;
    }
  }
  // A series token must mix letters and digits and be long enough to name a
  // family: a bare "4000" would otherwise match unrelated products.
  const seriesSegment = String(model ?? '')
    .split(/[\s\-_/]+/)
    .map(compact)
    .find(
      (segment) =>
        segment.length >= 5 && /\d/.test(segment) && /[a-z]/.test(segment),
    );
  return {
    modelKey: key.length >= 4 ? key : '',
    seriesKey: seriesSegment ?? '',
  };
}

/**
 * Severity band for a score, or for a label when the source published one.
 *
 * @param {number|null|undefined} score
 * @param {string} [label]
 * @returns {'critical'|'high'|'medium'|'low'|'unscored'}
 */
export function severityBand(score, label = '') {
  const named = String(label || '')
    .trim()
    .toLowerCase();
  if (Object.hasOwn(SEVERITY_RANK, named)) return named;
  const value = Number(score);
  if (!Number.isFinite(value) || value <= 0) return 'unscored';
  for (const band of SEVERITY_BANDS) {
    if (band.min > 0 && value >= band.min) return band.id;
  }
  return 'unscored';
}

/** Rank a severity for comparison; unknown values rank lowest. */
export function severityRank(severity) {
  return SEVERITY_RANK[severity] ?? 0;
}

/**
 * One advisory's CPE criterion → its product words.
 *
 * `cpe:2.3:o:axis:m10_series_network_cameras_firmware:*:…` yields
 * `m10_series_network_cameras_firmware`; the trailing capability word is
 * dropped so the model token can be compared with the catalogue's model.
 *
 * @param {string} criteria
 * @returns {{vendor:string, product:string}|null}
 */
export function cpeProduct(criteria) {
  const parts = String(criteria ?? '').split(':');
  if (parts.length < 6 || parts[0] !== 'cpe' || parts[1] !== '2.3') return null;
  const vendor = String(parts[3] ?? '').trim();
  const product = String(parts[4] ?? '').trim();
  if (!vendor || !product || product === '*') return null;
  return {
    vendor,
    product: product.replace(/_(?:firmware|software|os)$/i, ''),
  };
}

/**
 * Whether one advisory names a camera's model, and how precisely.
 *
 * @param {object} advisory
 * @param {{model:string}} hardware
 * @param {{modelKey:string, seriesKey:string}} keys
 * @returns {'model'|'series'|null}
 */
export function matchPrecision(advisory, hardware, keys) {
  const products = Array.isArray(advisory?.products) ? advisory.products : [];
  const text = products.map((product) => compact(product)).join(' ');
  if (!text) return null;
  if (keys.modelKey && text.includes(keys.modelKey)) return 'model';
  if (keys.seriesKey && keys.seriesKey !== keys.modelKey) {
    if (text.includes(keys.seriesKey)) return 'series';
  }
  return null;
}

/** Trim a CVE description to a readable one-line title. */
export function advisoryTitle(text, fallback = '') {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return String(fallback ?? '');
  return clean.length > 180 ? `${clean.slice(0, 177)}…` : clean;
}

/**
 * Cross the catalogue with the advisory records.
 *
 * Cameras without a published brand and model are counted, never guessed at.
 * Advisories whose brand is in the fleet but whose product line is not are
 * counted as brand context. Findings are worst-first, one entry per camera.
 *
 * @param {object} input
 * @param {Array<object>} input.cameras catalogued cameras
 * @param {Array<object>} input.advisories advisory records
 * @param {number} [input.maxFindings]
 * @returns {{findings:Array<object>, stats:object}}
 */
export function buildFindings({ cameras, advisories, maxFindings = 600 }) {
  const list = Array.isArray(cameras) ? cameras : [];
  const records = (Array.isArray(advisories) ? advisories : []).filter(
    (record) =>
      record &&
      record.id &&
      Array.isArray(record.products) &&
      record.products.length,
  );

  const byBrand = new Map();
  for (const record of records) {
    for (const brand of Array.isArray(record.brands) ? record.brands : []) {
      const bucket = byBrand.get(brand) ?? [];
      bucket.push(record);
      byBrand.set(brand, bucket);
    }
  }

  const findings = [];
  let identified = 0;
  let unmatchedBrands = 0;
  const matchedAdvisories = new Set();
  const brandCounts = new Map();

  for (const camera of list) {
    const hardware = cameraHardware(camera);
    if (!hardware) continue;
    identified += 1;
    const brand = brandRecord(hardware.brand);
    if (!brand) continue;
    brandCounts.set(hardware.brand, (brandCounts.get(hardware.brand) ?? 0) + 1);
    const keys = modelKeys(hardware.model, hardware.brand);
    if (!keys.modelKey) {
      unmatchedBrands += 1;
      continue;
    }
    const matches = [];
    const seen = new Set();
    for (const record of byBrand.get(hardware.brand) ?? []) {
      const precision = matchPrecision(record, hardware, keys);
      if (!precision) continue;
      const dedupe = `${record.source}:${record.id}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      matchedAdvisories.add(dedupe);
      matches.push({
        source: record.source,
        id: record.id,
        title: record.title,
        url: record.url,
        published: record.published ?? null,
        updated: record.updated ?? null,
        score: Number.isFinite(record.score) ? record.score : null,
        severity: record.severity ?? severityBand(record.score),
        cves: Array.isArray(record.cves) ? record.cves : [],
        match: precision,
      });
    }
    if (!matches.length) continue;
    matches.sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        (b.score ?? -1) - (a.score ?? -1) ||
        String(a.id).localeCompare(String(b.id)),
    );
    const clipped = matches.slice(0, MAX_MATCHES_PER_CAMERA);
    findings.push({
      id: String(camera.id),
      name: String(camera.name ?? camera.id),
      lat: Number(camera.lat),
      lon: Number(camera.lon),
      brand: hardware.brand,
      model: hardware.model,
      matches: clipped,
      worstSeverity: clipped[0].severity,
      worstScore: clipped[0].score,
      advisoryCount: matches.length,
    });
  }

  findings.sort(
    (a, b) =>
      severityRank(b.worstSeverity) - severityRank(a.worstSeverity) ||
      (b.worstScore ?? -1) - (a.worstScore ?? -1) ||
      a.id.localeCompare(b.id),
  );
  const kept = findings.slice(0, Math.max(1, maxFindings));
  const bySeverity = Object.fromEntries(
    SEVERITY_BANDS.map((band) => [band.id, 0]),
  );
  for (const finding of findings) {
    bySeverity[finding.worstSeverity] =
      (bySeverity[finding.worstSeverity] ?? 0) + 1;
  }

  return {
    findings: kept,
    stats: {
      cameras: list.length,
      identified,
      flagged: findings.length,
      truncated: findings.length > kept.length,
      bySeverity,
      advisories: records.length,
      // Advisories for a fleet brand whose product line matched no camera are
      // context, not findings: the fleet may run other models of that brand.
      brandOnlyAdvisories: records.filter(
        (record) => !matchedAdvisories.has(`${record.source}:${record.id}`),
      ).length,
      brands: [...brandCounts.entries()]
        .map(([id, count]) => ({ id, cameras: count }))
        .sort((a, b) => b.cameras - a.cameras || a.id.localeCompare(b.id)),
      unmatchedHardware: unmatchedBrands,
    },
  };
}
