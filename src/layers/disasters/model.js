/**
 * Display helpers and record mapping for the Global disasters layer. Pure:
 * no DOM, no Cesium import.
 * @module layers/disasters/model
 */

/** Alert colors, shared between GDACS events and EMS activations. */
export const ALERT_COLORS = Object.freeze({
  red: [224, 32, 32],
  orange: [240, 138, 32],
  green: [40, 180, 90],
  amber: [232, 180, 64],
});

const ALERT_COLOR_BY_LEVEL = Object.freeze({
  red: ALERT_COLORS.red,
  orange: ALERT_COLORS.orange,
  green: ALERT_COLORS.green,
  blue: ALERT_COLORS.amber,
});

/** Map a GDACS alert level (or the EMS "Active" flag) to display color. */
export function alertColor(alertLevel) {
  const key = String(alertLevel ?? '')
    .trim()
    .toLowerCase();
  if (key === 'red') return ALERT_COLORS.red;
  if (key === 'orange') return ALERT_COLORS.orange;
  if (key === 'green') return ALERT_COLORS.green;
  if (key === 'active') return ALERT_COLORS.amber;
  return ALERT_COLORS.amber;
}

/** Color an EFFIS burnt-area record by its mapped hectares. */
export function fireAreaColor(areaHa) {
  const hectares = Number(areaHa);
  if (!Number.isFinite(hectares)) return ALERT_COLORS.amber;
  if (hectares >= 5000) return [216, 26, 26];
  if (hectares >= 800) return [232, 122, 32];
  return [188, 168, 60];
}

/** Point radius in metres: red/orange events read first on shared space. */
export function eventRadiusMeters({ severity, alertLevel }) {
  const level = String(alertLevel ?? '').toLowerCase();
  const base = level === 'red' ? 60_000 : level === 'orange' ? 40_000 : 28_000;
  const parsed = Number(severity);
  if (!Number.isFinite(parsed) || parsed <= 0) return base;
  return Math.min(base * (1 + parsed / 400), 240_000);
}

/** Activation pin radius in metres. */
export const ACTIVATION_RADIUS_M = 30_000;

/** Analyst query projection for the voice result display and HUD cards. */
export function mapAnalystRecords(rows, { maxCount = 2000 } = {}) {
  const limit = Number.isFinite(maxCount) ? Math.max(0, Math.floor(maxCount)) : 2000;
  return rows.slice(0, limit).map((row, index) => ({
    id: row.stableId,
    hazard: row.hazard,
    name: row.name,
    country: row.country,
    alertLevel: row.alertLevel,
    timeMs: row.timeMs,
    areaHa: row.areaHa,
    lat: row.lat,
    lon: row.lon,
    order: index,
  }));
}
