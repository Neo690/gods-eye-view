// The fixed sites this layer hands to the Sentinel's patrol.
//
// The installations layer draws records from OSM and Google Places; the
// Sentinel walks to one of them per inspection, so it needs the positions in
// one shape with a stable id and a readable label. A record without both
// coordinates has nowhere to stand and is left out rather than snapped onto
// the equator by a numeric cast.
// @module layers/installations/patrolSites

const DEFAULT_LIMIT = 500;

/**
 * Read a requested cap as a positive whole number; anything unusable falls
 * back to the default rather than reading nothing.
 */
function limitOf(maxCount) {
  if (!Number.isFinite(maxCount)) return DEFAULT_LIMIT;
  return Math.max(1, Math.floor(maxCount));
}

/**
 * The layer's records as patrol sites, capped and in record order.
 *
 * @param {Array<{id?:string, name?:string, latitude?:number,
 *   longitude?:number}>} records the layer's current records.
 * @param {number} [maxCount] most sites to return (default 500).
 * @returns {Array<{id:string, label:string, latitude:number,
 *   longitude:number}>}
 */
export function patrolSitesFromRecords(records, maxCount = DEFAULT_LIMIT) {
  const limit = limitOf(maxCount);
  const sites = [];
  for (const record of records ?? []) {
    // `Number(null)` and `Number('')` are both 0, which would plant a
    // positionless record on the equator, so an absent coordinate is rejected
    // before the cast.
    if (
      record?.latitude == null ||
      record?.longitude == null ||
      record.latitude === '' ||
      record.longitude === ''
    )
      continue;
    const latitude = Number(record.latitude);
    const longitude = Number(record.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    sites.push({
      id: String(record.id ?? ''),
      label: String(record.name ?? ''),
      latitude,
      longitude,
    });
    if (sites.length >= limit) break;
  }
  return sites;
}
