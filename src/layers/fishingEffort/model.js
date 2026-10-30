/**
 * Global Fishing Watch apparent fishing effort, reduced to what a globe can
 * draw.
 *
 * The proxy answers `{ cells: [{ lat, lon, hours }], totalHours, cellCount,
 * truncated }` from a 4Wings report over the current viewport. Nothing here
 * decides where a vessel is: a cell is a *sum of apparent fishing hours* over a
 * 0.1° square for a date range, computed by GFW from AIS behaviour. The layer
 * says "effort", never "a trawler is here".
 *
 * Pure: no Cesium, no DOM, no network.
 * @module layers/fishingEffort/model
 */

export const FISHING_EFFORT_LAYER_ID = 'fishing-effort';

/** Below this the grid is noise; the proxy already caps the count. */
export const MAX_DRAWN_CELLS = 800;

/** The viewport span this layer will ask for, in degrees. */
export const MAX_VIEW_SPAN = Object.freeze({ lon: 90, lat: 60 });

/** Default window: a week of effort behind the view. */
export const DEFAULT_DAYS = 7;

/** The colour scale's ceiling is a percentile, not the absolute maximum. */
export function hoursCeiling(cells) {
  const values = (cells || [])
    .map((cell) => Number(cell?.hours))
    .filter((hours) => Number.isFinite(hours) && hours > 0)
    .sort((a, b) => a - b);
  if (!values.length) return 0;
  // The 95th percentile keeps one prolific cell from flattening the rest.
  const index = Math.min(values.length - 1, Math.floor(values.length * 0.95));
  return values[index];
}

/**
 * A cell's share of the scale, 0–1, on a square-root curve so the many
 * low-effort cells stay visible beside the few intense ones.
 * @param {number} hours
 * @param {number} ceiling
 */
export function intensity(hours, ceiling) {
  const value = Number(hours);
  const top = Number(ceiling);
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isFinite(top) ||
    top <= 0
  )
    return 0;
  return Math.min(1, Math.sqrt(value / top));
}

/** One sentence for the row: what the cells add up to. */
export function effortSummary({ totalHours, cellCount, days } = {}) {
  const hours = Number(totalHours);
  const cells = Number(cellCount);
  if (
    !Number.isFinite(hours) ||
    hours <= 0 ||
    !Number.isFinite(cells) ||
    cells <= 0
  )
    return null;
  const rounded =
    hours >= 100 ? Math.round(hours) : Math.round(hours * 10) / 10;
  const span = Number.isFinite(Number(days)) ? `${Number(days)}d` : '7d';
  return `${rounded} h · ${cells} cells · ${span}`;
}

/**
 * Validate and clip a proxy answer. A row without a finite coordinate or a
 * positive hour count is dropped rather than drawn at (0, 0).
 */
export function normalizeEffort(payload, { limit = MAX_DRAWN_CELLS } = {}) {
  const rows = Array.isArray(payload?.cells) ? payload.cells : [];
  const cells = [];
  for (const row of rows) {
    const lat = Number(row?.lat);
    const lon = Number(row?.lon);
    const hours = Number(row?.hours);
    if (![lat, lon, hours].every(Number.isFinite)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || hours <= 0)
      continue;
    cells.push({ lat, lon, hours });
  }
  cells.sort((a, b) => b.hours - a.hours);
  const kept = cells.slice(0, Math.max(0, Math.floor(limit) || 0));
  return {
    cells: kept,
    totalHours: Number.isFinite(Number(payload?.totalHours))
      ? Number(payload.totalHours)
      : cells.reduce((sum, cell) => sum + cell.hours, 0),
    cellCount: Number.isFinite(Number(payload?.cellCount))
      ? Number(payload.cellCount)
      : cells.length,
    truncated: Boolean(payload?.truncated) || kept.length < cells.length,
    fetchedAt: Number.isFinite(Number(payload?.fetchedAt))
      ? Number(payload.fetchedAt)
      : null,
    stale: Boolean(payload?.stale),
  };
}

/** Whether a viewport is worth asking for, or too wide to be honest about. */
export function viewportAllowed({ west, east, south, north } = {}) {
  const values = [west, east, south, north].map(Number);
  if (!values.every(Number.isFinite)) return false;
  return (
    Math.abs(east - west) <= MAX_VIEW_SPAN.lon &&
    Math.abs(north - south) <= MAX_VIEW_SPAN.lat
  );
}

/** Degrees from a Cesium Rectangle's radians, for the request. */
export function boundsFromRadians({ west, east, south, north } = {}) {
  const degrees = (value) => (Number(value) * 180) / Math.PI;
  return {
    west: degrees(west),
    east: degrees(east),
    south: degrees(south),
    north: degrees(north),
  };
}
