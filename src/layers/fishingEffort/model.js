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

/** The 4Wings report's square, in degrees: the lattice zones are traced on. */
export const CELL_DEGREES = 0.1;

/** A zone is at least this many dense cells; fewer is a cluster, not an area. */
export const ZONE_MIN_CELLS = 4;

/**
 * A zone is made of the cells that carry the effort. Below this share of the
 * ceiling a cell is background fishing and would grow one coastline-wide
 * outline that says nothing.
 */
export const ZONE_MIN_INTENSITY = 0.2;

/** How many outlines are worth drawing at once. */
export const ZONE_LIMIT = 12;

const key = (i, j) => `${i}:${j}`;

/**
 * The sides of one kept cell that no other kept cell covers.
 *
 * Vertices are doubled lattice indices, so a cell's corners land on integers
 * and the joins between neighbouring sides are exact — no tolerance, no
 * floating-point gap that would leave a ring open.
 */
function boundarySegments(occupied) {
  const segments = [];
  for (const { i, j } of occupied.values()) {
    const x0 = i * 2 - 1;
    const x1 = i * 2 + 1;
    const y0 = j * 2 - 1;
    const y1 = j * 2 + 1;
    if (!occupied.has(key(i, j + 1)))
      segments.push([
        [x0, y1],
        [x1, y1],
      ]);
    if (!occupied.has(key(i, j - 1)))
      segments.push([
        [x0, y0],
        [x1, y0],
      ]);
    if (!occupied.has(key(i - 1, j)))
      segments.push([
        [x0, y0],
        [x0, y1],
      ]);
    if (!occupied.has(key(i + 1, j)))
      segments.push([
        [x1, y0],
        [x1, y1],
      ]);
  }
  return segments;
}

/** Drop the points that sit on a straight run, so an outline is a corner list. */
function simplifyRing(vertices) {
  if (vertices.length < 4) return vertices;
  const kept = [];
  for (let index = 0; index < vertices.length; index++) {
    const previous = vertices[(index - 1 + vertices.length) % vertices.length];
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    const cross =
      (current[0] - previous[0]) * (next[1] - current[1]) -
      (current[1] - previous[1]) * (next[0] - current[0]);
    if (cross !== 0) kept.push(current);
  }
  return kept.length >= 4 ? kept : vertices;
}

function ringPositions(vertices) {
  return vertices.map(([x, y]) => ({
    lat: (y / 2) * CELL_DEGREES,
    lon: (x / 2) * CELL_DEGREES,
  }));
}

function ringArea(positions) {
  let sum = 0;
  for (let index = 0; index < positions.length; index++) {
    const a = positions[index];
    const b = positions[(index + 1) % positions.length];
    sum += a.lon * b.lat - b.lon * a.lat;
  }
  return Math.abs(sum) / 2;
}

/**
 * The closed outlines of one zone, outer ring first.
 *
 * Walking the boundary of a union of squares is the only contour that both
 * follows the data and stays legible: a convex hull would swallow the water
 * between two arms of the same fishery, and a smoothing pass would invent
 * curves the grid does not have. A zone with a hole in it (a piece of coast, a
 * gap in coverage) yields that hole as a second ring.
 */
function traceRings(occupied) {
  const segments = boundarySegments(occupied);
  const byVertex = new Map();
  segments.forEach((segment, index) => {
    for (const point of segment) {
      const vertexKey = `${point[0]},${point[1]}`;
      const list = byVertex.get(vertexKey);
      if (list) list.push(index);
      else byVertex.set(vertexKey, [index]);
    }
  });
  const used = segments.map(() => false);
  const rings = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const vertices = [segments[start][0], segments[start][1]];
    let current = segments[start][1];
    const origin = vertices[0];
    let guard = segments.length * 4 + 8;
    while (guard-- > 0) {
      const candidates = (
        byVertex.get(`${current[0]},${current[1]}`) || []
      ).filter((index) => !used[index]);
      if (!candidates.length) break;
      const next = segments[candidates[0]];
      used[candidates[0]] = true;
      current =
        next[0][0] === current[0] && next[0][1] === current[1]
          ? next[1]
          : next[0];
      if (current[0] === origin[0] && current[1] === origin[1]) break;
      vertices.push(current);
    }
    if (vertices.length < 4) continue;
    const positions = ringPositions(simplifyRing(vertices));
    rings.push({ positions, area: ringArea(positions) });
  }
  rings.sort((a, b) => b.area - a.area);
  return rings;
}

/**
 * Split one zone into the pieces that actually share a side.
 *
 * Cells that meet only at a corner belong to the same zone — a fishery works a
 * band, and a diagonal chain is that band — but they do not enclose one area.
 * Tracing them as a single ring would draw the rectangle around the staircase,
 * which paints open water that carries no effort at all. Each side-connected
 * piece is therefore its own fillable outline: the band is still one zone, and
 * every square it occupies is described by an outline that follows it.
 */
function zoneOutlines(members) {
  const byKey = new Map(
    members.map((member) => [key(member.i, member.j), member]),
  );
  const seen = new Set();
  const outlines = [];
  for (const startKey of byKey.keys()) {
    if (seen.has(startKey)) continue;
    seen.add(startKey);
    const queue = [startKey];
    const piece = new Map();
    while (queue.length) {
      const member = byKey.get(queue.pop());
      piece.set(key(member.i, member.j), member);
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const neighbour = key(member.i + di, member.j + dj);
        if (!byKey.has(neighbour) || seen.has(neighbour)) continue;
        seen.add(neighbour);
        queue.push(neighbour);
      }
    }
    const rings = traceRings(piece);
    if (rings.length) outlines.push({ rings });
  }
  return outlines;
}

/**
 * Group the dense cells into activity zones with readable outlines.
 *
 * Cells that share an edge *or a corner* form one zone: a fishery works a
 * band, and a diagonal chain is the same band. Everything below
 * `minIntensity` is left out so a handful of intense squares cannot drag a
 * continent of background effort into the same outline, and a group smaller
 * than `minCells` is dropped rather than drawn as a dot with a border.
 *
 * @param {Array<{lat:number, lon:number, hours:number}>} cells
 * @param {object} [options]
 * @param {number} [options.ceiling] Per-cell hour scale; computed when omitted.
 * @param {number} [options.minIntensity]
 * @param {number} [options.minCells]
 * @param {number} [options.limit]
 * @returns {Array<{id:string, cellCount:number, totalHours:number,
 *   centroid:{lat:number, lon:number}, ringCount:number,
 *   outlines:Array<{rings:Array<{positions:Array<object>, area:number}>}>,
 *   bounds:{south:number, west:number, north:number, east:number}, intensity:number}>}
 */
export function activityZones(
  cells,
  {
    ceiling,
    minIntensity = ZONE_MIN_INTENSITY,
    minCells = ZONE_MIN_CELLS,
    limit = ZONE_LIMIT,
  } = {},
) {
  const top = Number(ceiling) > 0 ? Number(ceiling) : hoursCeiling(cells);
  if (!(top > 0)) return [];
  const floor = Number.isFinite(Number(minIntensity))
    ? Number(minIntensity)
    : ZONE_MIN_INTENSITY;
  const occupied = new Map();
  for (const cell of cells || []) {
    const lat = Number(cell?.lat);
    const lon = Number(cell?.lon);
    const hours = Number(cell?.hours);
    if (![lat, lon, hours].every(Number.isFinite) || hours <= 0) continue;
    if (intensity(hours, top) < floor) continue;
    const i = Math.round(lon / CELL_DEGREES);
    const j = Math.round(lat / CELL_DEGREES);
    const cellKey = key(i, j);
    const existing = occupied.get(cellKey);
    if (existing) existing.hours += hours;
    else occupied.set(cellKey, { i, j, hours });
  }
  if (!occupied.size) return [];

  const minimum = Math.max(1, Math.floor(Number(minCells) || ZONE_MIN_CELLS));
  const seen = new Set();
  const zones = [];
  for (const startKey of occupied.keys()) {
    if (seen.has(startKey)) continue;
    seen.add(startKey);
    const queue = [startKey];
    const members = [];
    while (queue.length) {
      const member = occupied.get(queue.pop());
      members.push(member);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (!di && !dj) continue;
          const neighbour = key(member.i + di, member.j + dj);
          if (!occupied.has(neighbour) || seen.has(neighbour)) continue;
          seen.add(neighbour);
          queue.push(neighbour);
        }
      }
    }
    if (members.length < minimum) continue;

    const outlines = zoneOutlines(members);
    if (!outlines.length) continue;

    let totalHours = 0;
    let weightedLat = 0;
    let weightedLon = 0;
    let south = Infinity;
    let west = Infinity;
    let north = -Infinity;
    let east = -Infinity;
    for (const member of members) {
      totalHours += member.hours;
      const lat = member.j * CELL_DEGREES;
      const lon = member.i * CELL_DEGREES;
      weightedLat += lat * member.hours;
      weightedLon += lon * member.hours;
      south = Math.min(south, lat - CELL_DEGREES / 2);
      north = Math.max(north, lat + CELL_DEGREES / 2);
      west = Math.min(west, lon - CELL_DEGREES / 2);
      east = Math.max(east, lon + CELL_DEGREES / 2);
    }
    const centroid =
      totalHours > 0
        ? { lat: weightedLat / totalHours, lon: weightedLon / totalHours }
        : { lat: (south + north) / 2, lon: (west + east) / 2 };
    zones.push({
      id: `zone:${centroid.lat.toFixed(2)}:${centroid.lon.toFixed(2)}`,
      cellCount: members.length,
      totalHours,
      centroid,
      outlines,
      ringCount: outlines.reduce(
        (sum, outline) => sum + outline.rings.length,
        0,
      ),
      bounds: { south, west, north, east },
    });
  }

  zones.sort((a, b) => b.totalHours - a.totalHours || a.id.localeCompare(b.id));
  const kept = zones.slice(0, Math.max(0, Math.floor(Number(limit) || 0)));
  const strongest = kept[0]?.totalHours || 0;
  for (const zone of kept)
    zone.intensity = strongest > 0 ? zone.totalHours / strongest : 0;
  return kept;
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
