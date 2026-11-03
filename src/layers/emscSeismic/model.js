import * as Cesium from 'cesium';
export const EMSC_OVERLAY_SOURCE_ID = 'emsc-seismic';
export const EMSC_OVERLAY_COHORT_LIMIT = 96;
export const EMSC_OVERLAY_COLLISION_CAPACITY = 48;

/**
 * Color by depth, mirroring the USGS earthquake layer's bands so the two
 * seismic layers read identically on the globe. Duplicated rather than shared
 * to keep the layer packages independent, as the boundaries require.
 */
export function depthColor(depthKm) {
  if (depthKm < 70) return Cesium.Color.RED;
  if (depthKm < 300) return Cesium.Color.ORANGE;
  return Cesium.Color.YELLOW;
}

/**
 * Build the source-owned presentation for one ambient magnitude label.
 * @param {object} input
 * @param {string} input.id Stable EMSC unid or deterministic fallback id.
 * @param {Cesium.Cartesian3} input.position Ground anchor shared with the pulse.
 * @param {number} input.magnitude EMSC magnitude.
 * @param {string} input.accent Source-owned depth-band color.
 * @returns {object}
 */
export function createEmscOverlayEntry({ id, position, magnitude, accent }) {
  const mag = Number(magnitude);
  return {
    id: String(id),
    position,
    variant: 'label',
    title: `M${mag.toFixed(1)}`,
    accent,
    priority: Math.round(mag * 1000),
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

/** Keep the largest events, with stable identity as the tie-break. */
export function selectEmscOverlayCohort(
  entries,
  limit = EMSC_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(EMSC_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
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
 * Map one earthquake's raw plain values to a JSON-safe analyst record
 * (analyst query engine seam). Pure — no Cesium types. Missing/unknown
 * fields are null, never NaN/undefined. Falls back to an index-based id
 * when the EMSC unid is absent.
 * @param {Object|null|undefined} raw - {id, mag, place, time, depth, lat, lon}.
 * @param {number} [index=0] - Position in the snapshot (fallback id only).
 * @returns {{id: string, magnitude: number|null, depthKm: number|null,
 *   lat: number|null, lon: number|null, timeMs: number|null, place: string|null}}
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t || null;
  };
  return {
    id: text(raw?.id) || `QEMSC-${String(index).padStart(4, '0')}`,
    magnitude: num(raw?.mag),
    depthKm: num(raw?.depth),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    timeMs: num(raw?.time), // parsed FDSN ISO time
    place: text(raw?.place),
  };
}

export { normalizeEmscEarthquakeSnapshot } from './records.js';
