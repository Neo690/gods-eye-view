/**
 * Normalize a conflict-event payload into rows the layer can draw.
 *
 * Two providers share this seam:
 *  - ACLED  — keyed, structured rows with reported fatalities.
 *  - GDELT  — keyless, geo-coded news articles (no casualty field).
 *
 * A malformed payload returns null so the layer keeps its last good snapshot
 * instead of blanking the globe. Individual unusable rows are skipped; a
 * structurally broken one fails the whole snapshot.
 */

/** Hard ceiling on rows kept from one snapshot. */
export const MAX_CONFLICT_EVENTS = 2000;

function asFinite(value) {
  // Number('') === 0: an empty CSV cell must not become a (0,0) coordinate.
  if (value == null || (typeof value === 'string' && value.trim() === ''))
    return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

/** Parse the provider date formats into epoch milliseconds. */
function parseTimeMs(value) {
  const text = asText(value);
  if (!text) return null;
  // GDELT uses "20261101T120000Z"; ACLED uses "2026-11-01".
  const normalized = /^\d{8}T\d{6}Z$/.test(text)
    ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(9, 11)}:${text.slice(11, 13)}:${text.slice(13, 15)}Z`
    : text.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function joinActors(a, b) {
  const parts = [asText(a), asText(b)].filter(Boolean);
  return parts.length ? parts.join(' / ') : null;
}

function pushRow(rows, ids, row) {
  if (ids.has(row.stableId)) return;
  ids.add(row.stableId);
  rows.push(row);
}

/**
 * Normalize ACLED's row shape.
 * @param {unknown} input - Array of ACLED records, or `{data: [...]}`.
 * @returns {Array<object>|null} Rows, or null when the payload is malformed.
 */
export function normalizeAcledRows(input) {
  const rows = Array.isArray(input) ? input : input?.data;
  if (!Array.isArray(rows)) return null;
  const out = [];
  const ids = new Set();
  for (const [index, raw] of rows.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const lat = asFinite(raw.latitude);
    const lon = asFinite(raw.longitude);
    if (lat == null || lon == null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const fatalities = asFinite(raw.fatalities);
    pushRow(out, ids, {
      stableId: asText(raw.event_id_cnty) ?? `acled-${index + 1}`,
      provider: 'acled',
      lat,
      lon,
      timeMs: parseTimeMs(raw.event_date),
      type: asText(raw.event_type),
      subType: asText(raw.sub_event_type),
      actors: joinActors(raw.actor1, raw.actor2),
      fatalities: fatalities != null && fatalities > 0 ? fatalities : 0,
      country: asText(raw.country),
      sourceUrl: null,
    });
    if (out.length >= MAX_CONFLICT_EVENTS) break;
  }
  return out;
}

/**
 * Normalize GDELT's DOC-API GeoJSON shape (one point per article cluster).
 * @param {unknown} payload - GeoJSON FeatureCollection.
 * @returns {Array<object>|null} Rows, or null when the payload is malformed.
 */
export function normalizeGdeltGeoJson(payload) {
  const features = payload?.features;
  if (!Array.isArray(features)) return null;
  const out = [];
  const ids = new Set();
  for (const [index, feature] of features.entries()) {
    if (!feature || typeof feature !== 'object') return null;
    const geometry = feature.geometry;
    if (geometry?.type != null && geometry.type !== 'Point') continue;
    const coordinates = geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const lon = asFinite(coordinates[0]);
    const lat = asFinite(coordinates[1]);
    if (lat == null || lon == null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const properties =
      feature.properties &&
      typeof feature.properties === 'object' &&
      !Array.isArray(feature.properties)
        ? feature.properties
        : {};
    const url = asText(properties.url) ?? asText(properties.documentidentifier);
    pushRow(out, ids, {
      stableId: url ?? asText(feature.id) ?? `gdelt-${index + 1}`,
      provider: 'gdelt',
      lat,
      lon,
      timeMs: parseTimeMs(properties.seendate),
      type: asText(properties.eventtype) ?? asText(properties.name),
      subType: null,
      actors: null,
      // GDELT carries no casualty count: absent is not zero, but the layer's
      // severity scale only needs a floor, so it maps to the lowest band.
      fatalities: 0,
      country: asText(properties.sourcecountry),
      sourceUrl: url,
    });
    if (out.length >= MAX_CONFLICT_EVENTS) break;
  }
  return out;
}

/**
 * Validate and normalize one provider payload.
 * @param {unknown} payload - Raw provider response.
 * @param {{provider?: 'acled'|'gdelt'}} [options]
 * @returns {Array<object>|null}
 */
export function normalizeConflictSnapshot(
  payload,
  { provider = 'gdelt' } = {},
) {
  return provider === 'acled'
    ? normalizeAcledRows(payload)
    : normalizeGdeltGeoJson(payload);
}
