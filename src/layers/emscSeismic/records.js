/**
 * Validate a complete EMSC feed before replacing the last good snapshot.
 *
 * The SeismicPortal FDSN query (`format=json`) returns an OGC GeoJSON
 * FeatureCollection whose event properties differ from USGS in three ways the
 * normalizer must absorb: `time` is an ISO-8601 string, not epoch ms;
 * `place` is the `flynn_region`; and, although the standard puts the depth as
 * the third coordinate, EMSC publishes it negated there (`-60.0`) while
 * `properties.depth` carries the positive kilometre value — so position and
 * depth are read from the properties when they are finite and only fall back
 * to the geometry, flipping the depth sign back.
 *
 * Rows use the same shape as the USGS feed so the lifecycle code stays a
 * copy: {stableId, emscId, lon, lat, depthKm, mag, place, time}.
 */
const ISO_TIME_MS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z?$/;

/** Parse the FDSN ISO event time into epoch milliseconds; null when unusable. */
export function parseEmscIsoTime(value) {
  if (typeof value !== 'string') return null;
  const match = ISO_TIME_MS.exec(value.trim());
  if (!match) return null;
  const [, seconds, fraction = '0'] = match;
  const ms =
    Date.parse(`${seconds}Z`) +
    Number(String(fraction).slice(0, 3).padEnd(3, '0'));
  return Number.isFinite(ms) ? ms : null;
}

/** Parse a coordinate the properties publish; null when missing or unusable. */
function signedCoordinate(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the event position. When the properties publish any coordinate, they
 * are authoritative: a value that is unusable or out of range invalidates the
 * event rather than silently falling back to the geometry.
 */
function positionOf(feature) {
  const properties = feature.properties ?? {};
  const propLat = signedCoordinate(properties.lat);
  const propLon = signedCoordinate(properties.lon);
  if (propLat !== null || propLon !== null) {
    if (
      propLat === null ||
      propLon === null ||
      Math.abs(propLat) > 90 ||
      Math.abs(propLon) > 180
    )
      return null;
    const depth = signedCoordinate(properties.depth);
    return { lat: propLat, lon: propLon, depthKm: depth };
  }
  const geometry = feature.geometry;
  if (geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates))
    return null;
  const [coordLon, coordLat, coordDepth] = geometry.coordinates;
  if (
    !Number.isFinite(coordLon) ||
    Math.abs(coordLon) > 180 ||
    !Number.isFinite(coordLat) ||
    Math.abs(coordLat) > 90
  )
    return null;
  if (coordDepth != null && !Number.isFinite(coordDepth)) return null;
  return {
    lat: coordLat,
    lon: coordLon,
    depthKm: coordDepth == null ? null : -coordDepth,
  };
}

export function normalizeEmscEarthquakeSnapshot(payload) {
  if (!Array.isArray(payload?.features)) return null;
  const rows = [];
  const ids = new Set();
  for (const [index, feature] of payload.features.entries()) {
    const properties = feature?.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      return null;
    const position = positionOf(feature);
    if (!position) return null;
    const mag = properties.mag;
    if (mag != null && (!Number.isFinite(Number(mag)) || Number(mag) > 10))
      return null;
    // A missing magnitude cannot establish that this event meets the floor the
    // source requests; skip the event instead of displaying an unbounded dot.
    if (mag == null || Number(mag) < 2.5) continue;
    const emscId =
      typeof properties.unid === 'string' && properties.unid !== ''
        ? properties.unid
        : typeof feature.id === 'string' && feature.id !== ''
          ? feature.id
          : null;
    const stableId = emscId ?? `event-${index + 1}`;
    if (ids.has(stableId)) return null;
    ids.add(stableId);
    rows.push({
      stableId,
      emscId,
      lon: position.lon,
      lat: position.lat,
      depthKm: position.depthKm,
      mag: Number(mag),
      place:
        typeof properties.flynn_region === 'string'
          ? properties.flynn_region
          : null,
      time: parseEmscIsoTime(properties.time),
      magtype:
        typeof properties.magtype === 'string' ? properties.magtype : null,
    });
  }
  return rows;
}
