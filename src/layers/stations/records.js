/**
 * @module layers/stations/records
 * @description Normalize an Overpass answer into station records. Pure: no
 * Cesium, no network, exercised directly by node:test.
 *
 * A station is drawn only when it has a name. An unnamed `railway=station` is
 * usually a node a mapper left for someone else; drawing it would put a dot on
 * the globe that no card, label or search could ever name, and a view full of
 * those reads as noise rather than as a place.
 */

import { QUERY_LIMIT } from './policy.js';

/** Two records closer than this with the same name are one station. */
export const SAME_STATION_METERS = 300;

/**
 * Distance in metres, flat-earth within a view. Never used for anything but
 * the duplicate test below, where the view is regional by construction.
 *
 * @param {{lat:number, lon:number}} a
 * @param {{lat:number, lon:number}} b
 * @returns {number}
 */
export function approxMeters(a, b) {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLon =
    (a.lon - b.lon) *
    111_320 *
    Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * Coordinates of one Overpass element, whatever its geometry.
 *
 * @param {object} element
 * @returns {{lat:number, lon:number}|null}
 */
export function elementPosition(element) {
  const lat = Number.isFinite(element?.lat)
    ? element.lat
    : Number.isFinite(element?.center?.lat)
      ? element.center.lat
      : NaN;
  const lon = Number.isFinite(element?.lon)
    ? element.lon
    : Number.isFinite(element?.center?.lon)
      ? element.center.lon
      : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/** Trimmed tag value, or null. */
function tag(element, key) {
  const raw = element?.tags?.[key];
  const text = String(raw ?? '').trim();
  return text || null;
}

/**
 * Normalize one Overpass element into a station record, or null when it is not
 * a named station with a usable position.
 *
 * @param {object} element
 * @returns {{id:string, name:string, lat:number, lon:number,
 *   operator:string|null, network:string|null, usage:string|null,
 *   platforms:number|null}|null}
 */
export function normalizeStationElement(element) {
  if (!element || element.tags?.railway !== 'station') return null;
  const at = elementPosition(element);
  if (!at) return null;
  const name = tag(element, 'name');
  if (!name) return null;
  const platforms = Number.parseInt(tag(element, 'platforms') ?? '', 10);
  return {
    id: `${element.type || 'node'}/${element.id}`,
    name,
    lat: at.lat,
    lon: at.lon,
    operator: tag(element, 'operator'),
    network: tag(element, 'network'),
    usage: tag(element, 'usage'),
    platforms: Number.isFinite(platforms) ? platforms : null,
  };
}

/**
 * Normalize a whole Overpass answer, dropping unnamed, unpositioned and
 * duplicate stations.
 *
 * The same station is often mapped twice — a node for the stop and a way for
 * the building — and both carry the same name. Keeping the first one seen and
 * dropping a same-named neighbour within SAME_STATION_METERS draws it once.
 *
 * @param {unknown} elements
 * @returns {{records:object[], saturated:boolean}}
 */
export function normalizeStations(elements) {
  if (!Array.isArray(elements)) return { records: [], saturated: false };
  const saturated = elements.length >= QUERY_LIMIT;
  const records = [];
  for (const element of elements.slice(0, QUERY_LIMIT)) {
    const record = normalizeStationElement(element);
    if (!record) continue;
    const duplicate = records.some(
      (kept) =>
        kept.name.toLowerCase() === record.name.toLowerCase() &&
        approxMeters(kept, record) < SAME_STATION_METERS,
    );
    if (duplicate) continue;
    records.push(record);
  }
  return { records, saturated };
}
