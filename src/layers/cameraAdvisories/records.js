/**
 * Pure helpers for the camera-advisory layer.
 *
 * The server does the join; this module decides what a payload is allowed to
 * become on the globe. A finding is only drawn when its camera has a real
 * position and at least one advisory with an identifier — a malformed record
 * is dropped rather than shown at the equator or with an empty label.
 *
 * No Cesium, no DOM, no i18n here: the layer formats and translates.
 */

/** Markers one payload may contribute. */
export const MAX_ADVISORY_FINDINGS = 800;

/** Severity bands, worst first — the same vocabulary the server emits. */
export const ADVISORY_BANDS = Object.freeze([
  Object.freeze({ id: 'critical', color: '#ff3b5c', rank: 5 }),
  Object.freeze({ id: 'high', color: '#ff8a3d', rank: 4 }),
  Object.freeze({ id: 'medium', color: '#ffd166', rank: 3 }),
  Object.freeze({ id: 'low', color: '#7fd8ff', rank: 2 }),
  Object.freeze({ id: 'unscored', color: '#8a94a6', rank: 1 }),
]);

const BAND_BY_ID = new Map(ADVISORY_BANDS.map((band) => [band.id, band]));

/** Colour for a severity, defaulting to the unknown shade. */
export function severityColor(severity) {
  return (BAND_BY_ID.get(severity) ?? BAND_BY_ID.get('unscored')).color;
}

/** Comparison rank for a severity; unknown ranks below every band. */
export function severityRank(severity) {
  return BAND_BY_ID.get(severity)?.rank ?? 0;
}

/** One match from the payload, or null when it cannot be shown as a source. */
export function normalizeMatch(match) {
  if (!match || typeof match !== 'object') return null;
  const id = String(match.id ?? '').trim();
  if (!id) return null;
  return {
    source: match.source === 'cisa' ? 'cisa' : 'nvd',
    id,
    title: String(match.title ?? id).trim() || id,
    url: typeof match.url === 'string' ? match.url : '',
    published: match.published ?? null,
    updated: match.updated ?? null,
    score: Number.isFinite(Number(match.score)) ? Number(match.score) : null,
    severity: BAND_BY_ID.has(match.severity) ? match.severity : 'unscored',
    cves: Array.isArray(match.cves)
      ? match.cves.filter((cve) => typeof cve === 'string').slice(0, 40)
      : [],
    match: match.match === 'series' ? 'series' : 'model',
  };
}

/** One flagged camera, or null when it has no usable position or advisory. */
export function normalizeFinding(finding) {
  if (!finding || typeof finding !== 'object') return null;
  const id = String(finding.id ?? '').trim();
  const lat = Number(finding.lat);
  const lon = Number(finding.lon);
  if (!id) return null;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  const matches = (Array.isArray(finding.matches) ? finding.matches : [])
    .map(normalizeMatch)
    .filter(Boolean)
    .sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) ||
        (b.score ?? -1) - (a.score ?? -1) ||
        a.id.localeCompare(b.id),
    );
  if (!matches.length) return null;
  return {
    id,
    name: String(finding.name ?? id).trim() || id,
    lat,
    lon,
    brand: String(finding.brand ?? '').trim(),
    model: String(finding.model ?? '').trim(),
    matches,
    worstSeverity: matches[0].severity,
    worstScore: matches[0].score,
  };
}

/** Severity counts recomputed from what is actually drawn. */
export function severityCounts(findings) {
  const counts = Object.fromEntries(ADVISORY_BANDS.map((band) => [band.id, 0]));
  for (const finding of Array.isArray(findings) ? findings : []) {
    counts[finding.worstSeverity] = (counts[finding.worstSeverity] ?? 0) + 1;
  }
  return counts;
}

/**
 * Validate one `/api/camera-advisories` answer.
 *
 * Returns null for a body that is not this route's shape at all (so a proxy
 * error page can never blank the layer with a fake zero), and a snapshot with
 * whatever it could validate otherwise.
 *
 * @param {object} payload
 * @returns {object|null}
 */
export function normalizeAdvisoryPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (!Array.isArray(payload.findings)) return null;
  const findings = payload.findings
    .map(normalizeFinding)
    .filter(Boolean)
    .slice(0, MAX_ADVISORY_FINDINGS);
  const counts = severityCounts(findings);
  const declared =
    payload.counts && typeof payload.counts === 'object' ? payload.counts : {};
  return {
    generatedAt:
      typeof payload.generatedAt === 'string' ? payload.generatedAt : null,
    findings,
    counts: {
      ...counts,
      advisories: Number(declared.advisories) || 0,
      brandOnlyAdvisories: Number(declared.brandOnlyAdvisories) || 0,
      truncated:
        payload.findings.length > findings.length ||
        declared.truncated === true,
    },
    cameras: {
      total: Number(payload.cameras?.total) || 0,
      identified: Number(payload.cameras?.identified) || 0,
      brands: Array.isArray(payload.cameras?.brands)
        ? payload.cameras.brands
            .filter((brand) => brand && typeof brand.id === 'string')
            .map((brand) => ({
              id: brand.id,
              cameras: Number(brand.cameras) || 0,
              queried: brand.queried === true,
            }))
        : [],
    },
    sources: Array.isArray(payload.sources)
      ? payload.sources
          .filter((source) => source && typeof source.id === 'string')
          .map((source) => ({
            id: source.id,
            ok: source.ok !== false,
            advisories: Number(source.advisories) || 0,
            ...(source.error ? { error: String(source.error) } : {}),
          }))
      : [],
    firmwareObserved: payload.firmwareObserved === true,
    deviceContact: payload.deviceContact === 'none' ? 'none' : 'unknown',
    ageMs: Number(payload.ageMs) || 0,
    stale: payload.stale === true,
  };
}

/**
 * The row's short list: the worst findings, one entry per camera.
 *
 * @param {Array<object>} findings
 * @param {number} [limit]
 * @returns {Array<{id:string, ordinal:number, lead:string, text:string, accent:string}>}
 */
export function advisoryListItems(findings, limit = 5) {
  return (Array.isArray(findings) ? findings : [])
    .slice(0, Math.max(0, limit))
    .map((finding, index) => {
      const worst = finding.matches[0];
      const score = Number.isFinite(finding.worstScore)
        ? finding.worstScore.toFixed(1)
        : '';
      return {
        id: `advisory:${finding.id}`,
        ordinal: index + 1,
        lead: score || worst.id,
        text: [
          finding.name,
          [finding.brand, finding.model].filter(Boolean).join(' '),
          worst.id,
        ]
          .filter(Boolean)
          .join(' · '),
        accent: severityColor(finding.worstSeverity),
      };
    });
}

/**
 * Camera and advisory lines for the hover tip. The last line is the layer's
 * own honesty note, appended by the caller with its translation.
 *
 * @param {object} finding
 * @returns {string[]}
 */
export function advisoryHoverLines(finding) {
  const worst = finding?.matches?.[0];
  if (!worst) return [];
  const score = Number.isFinite(finding.worstScore)
    ? Number(finding.worstScore).toFixed(1)
    : null;
  const more = finding.matches.length - 1;
  return [
    finding.name,
    [finding.brand, finding.model].filter(Boolean).join(' '),
    `${worst.id}${score ? ` · CVSS ${score}` : ''}${more > 0 ? ` (+${more})` : ''}`,
    worst.cves.slice(0, 3).join(', '),
  ].filter(Boolean);
}

/** Sources that failed to answer, for the row's error line. */
export function failedAdvisorySources(snapshot) {
  return (snapshot?.sources ?? [])
    .filter((source) => source.ok === false)
    .map((source) => source.id);
}

/** Brands NVD was not asked about, so the row can say coverage is partial. */
export function unqueriedBrands(snapshot) {
  return (snapshot?.cameras?.brands ?? [])
    .filter((brand) => brand.queried !== true)
    .map((brand) => brand.id);
}
