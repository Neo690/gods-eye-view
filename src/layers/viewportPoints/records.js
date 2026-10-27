/**
 * Pure helpers for viewport-bounded point layers (connected objects, radio
 * sites). No Cesium and no DOM here: the engine renders, this module decides
 * what a view is worth asking for and what a row is allowed to become.
 */

/** Widest span a single request may cover, in degrees of longitude. */
export const MAX_SPAN_DEG = 6;

/** Most points one response may contribute to the scene. */
export const MAX_POINTS = 800;

/** Longitude/latitude sanity, and a degenerate view is not a query. */
export function normaliseBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const west = Number(value.west);
  const south = Number(value.south);
  const east = Number(value.east);
  const north = Number(value.north);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (south >= north) return null;
  return {
    west: Math.max(-180, Math.min(180, west)),
    south: Math.max(-90, Math.min(90, south)),
    east: Math.max(-180, Math.min(180, east)),
    north: Math.max(-90, Math.min(90, north)),
  };
}

/**
 * Shrink a view to what one upstream call can answer. A world-scale view has a
 * view rectangle the whole planet wide; asking a provider for that is both a
 * timeout and a rate-limit. The centre is kept, because that is the part of
 * the screen the operator is actually looking at.
 *
 * @param {{west:number,south:number,east:number,north:number}} bounds
 * @param {number} [maxSpanDeg]
 * @returns {{bounds:{west:number,south:number,east:number,north:number}, clamped:boolean}}
 */
export function clampViewport(bounds, maxSpanDeg = MAX_SPAN_DEG) {
  const normalised = normaliseBounds(bounds);
  if (!normalised) return { bounds: null, clamped: false };
  const span = Math.max(0.01, maxSpanDeg);
  const lonSpan = Math.abs(normalised.east - normalised.west);
  const latSpan = normalised.north - normalised.south;
  if (lonSpan <= span && latSpan <= span)
    return { bounds: normalised, clamped: false };
  const lon = (normalised.west + normalised.east) / 2;
  const lat = (normalised.south + normalised.north) / 2;
  const halfLon = Math.min(span, lonSpan) / 2;
  const halfLat = Math.min(span, latSpan) / 2;
  return {
    bounds: {
      west: Math.max(-180, lon - halfLon),
      east: Math.min(180, lon + halfLon),
      south: Math.max(-90, lat - halfLat),
      north: Math.min(90, lat + halfLat),
    },
    clamped: true,
  };
}

/** Query string for the provider routes; shared by both layers. */
export function boundsQuery(bounds, extra = {}) {
  const normalised = normaliseBounds(bounds);
  if (!normalised) return '';
  const params = new URLSearchParams({
    west: normalised.west.toFixed(4),
    south: normalised.south.toFixed(4),
    east: normalised.east.toFixed(4),
    north: normalised.north.toFixed(4),
  });
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== '')
      params.set(name, String(value));
  }
  return params.toString();
}

/**
 * One row of either provider became a point, or it did not. Coordinate order,
 * string numbers and NaN are the three ways upstreams differ; a row that
 * cannot be placed is dropped rather than drawn at the equator.
 *
 * @param {object} row
 * @param {string} [fallbackId]
 * @returns {{id:string, lat:number, lon:number, label:string, meta:object}|null}
 */
export function normalisePoint(row, fallbackId = '') {
  if (!row || typeof row !== 'object') return null;
  const lat = Number(row.lat ?? row.latitude);
  const lon = Number(row.lon ?? row.lng ?? row.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const id = String(row.id ?? row._id ?? fallbackId ?? '').trim();
  if (!id) return null;
  return {
    id,
    lat,
    lon,
    label: String(row.label ?? row.name ?? id),
    meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
  };
}

/** Normalise a provider payload's rows and keep the first point per id. */
export function normalisePoints(rows, limit = MAX_POINTS) {
  const out = [];
  const seen = new Set();
  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    if (out.length >= limit) break;
    const point = normalisePoint(row, `row-${index}`);
    if (!point || seen.has(point.id)) continue;
    seen.add(point.id);
    out.push(point);
  }
  return out;
}

/**
 * Identity of what is drawn. Rendering 800 points because one label changed is
 * the difference between a smooth camera and a stutter, so the signature holds
 * only what the primitives show.
 */
export function pointsSignature(points) {
  return (Array.isArray(points) ? points : [])
    .map(
      (point) => `${point.id}:${point.lat.toFixed(4)}:${point.lon.toFixed(4)}`,
    )
    .join('|');
}
