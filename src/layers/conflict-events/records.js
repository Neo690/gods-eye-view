/**
 * Normalize a conflict-event payload into rows the layer can draw.
 *
 * ACLED is the only provider: keyed, structured rows with reported fatalities.
 * The proxy has no keyless fallback, and a payload that is not ACLED's is
 * malformed — there is no second shape to read it as.
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
  // ACLED sends a calendar day ("2026-11-01"); a timestamp with a space is
  // still accepted.
  const ms = Date.parse(text.replace(' ', 'T'));
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
 * Validate and normalize the ACLED payload the proxy serves.
 *
 * One name for the snapshot seam: the source and the panel never depend on the
 * provider's row shape, and there is no second provider to select.
 * @param {unknown} payload - Raw proxy response.
 * @returns {Array<object>|null}
 */
export function normalizeConflictSnapshot(payload) {
  return normalizeAcledRows(payload);
}
