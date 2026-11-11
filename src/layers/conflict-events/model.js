import { t, tn } from '../../i18n/index.js';
import * as Cesium from 'cesium';

export const CONFLICT_OVERLAY_SOURCE_ID = 'conflict-events';
export const CONFLICT_OVERLAY_COHORT_LIMIT = 120;
export const CONFLICT_OVERLAY_COLLISION_CAPACITY = 60;

/**
 * Severity by reported fatalities. Everything without a casualty count
 * (GDELT) lands in the lowest band, which reads as "reported incident".
 */
export function fatalityColor(fatalities) {
  const count = Number(fatalities);
  if (!Number.isFinite(count) || count <= 0) return Cesium.Color.GOLD;
  if (count < 10) return Cesium.Color.ORANGE;
  return Cesium.Color.RED;
}

/** Relative draw size so lethal events stay legible when zoomed out. */
export function fatalityPixelSize(fatalities) {
  const count = Number(fatalities);
  if (!Number.isFinite(count) || count <= 0) return 5;
  if (count < 10) return 7;
  return 9;
}

/**
 * Build the source-owned ambient label for one event location.
 * @param {object} input
 * @param {string} input.id Stable provider id.
 * @param {Cesium.Cartesian3} input.position Ground anchor shared with the dot.
 * @param {number} input.fatalities Reported deaths (0 when unknown).
 * @param {string} input.accent Severity color as CSS string.
 * @param {string} [input.title] Short label; falls back to the severity band.
 * @returns {object}
 */
export function createConflictOverlayEntry({
  id,
  position,
  fatalities,
  accent,
  title,
}) {
  const count = Number(fatalities);
  const lethal = Number.isFinite(count) && count > 0;
  return {
    id: String(id),
    position,
    variant: 'label',
    title:
      title ||
      (lethal ? tn(count, '{count} killed', '{count} killed') : t('Incident')),
    accent,
    priority: lethal ? Math.round(count) + 1 : 0,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the deadliest events, with stable identity as the tie-break. */
export function selectConflictOverlayCohort(
  entries,
  limit = CONFLICT_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(CONFLICT_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * Map one event's plain values to a JSON-safe analyst record.
 * Pure — no Cesium types. Missing fields are null, never NaN/undefined.
 * @param {Object|null|undefined} raw
 * @param {number} [index=0] - Position in the snapshot (fallback id only).
 * @returns {{id: string, lat: number|null, lon: number|null,
 *   timeMs: number|null, type: string|null, subType: string|null,
 *   actors: string|null, fatalities: number|null, country: string|null,
 *   provider: string|null, sourceUrl: string|null}}
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  return {
    id: text(raw?.id) || `CONFLICT-${String(index).padStart(4, '0')}`,
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    timeMs: num(raw?.timeMs),
    type: text(raw?.type),
    subType: text(raw?.subType),
    actors: text(raw?.actors),
    fatalities: num(raw?.fatalities),
    country: text(raw?.country),
    provider: text(raw?.provider),
    sourceUrl: text(raw?.sourceUrl),
  };
}

export { normalizeConflictSnapshot } from './records.js';
