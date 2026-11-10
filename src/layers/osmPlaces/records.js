/**
 * @module layers/osmPlaces/records
 * @description Normalize an Overpass answer into place rows for the viewport
 * points engine. Pure: no Cesium, no network, exercised directly by node:test.
 *
 * A place is drawn only when it has a name. The query already asks for
 * `name`, but a mapper can leave an empty value; a dot that no hover, label or
 * search can name reads as noise rather than as a place.
 */

import { QUERY_LIMIT, categoryFor, kindFor } from './policy.js';

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
  const text = String(element?.tags?.[key] ?? '').trim();
  return text || null;
}

/**
 * Normalize one Overpass element into a place row, or null when it is not a
 * named place with a usable position.
 *
 * @param {object} element
 * @returns {{id:string, lat:number, lon:number, label:string,
 *   meta:{category:string, kind:string}}|null}
 */
export function normalizePlaceElement(element) {
  if (!element || typeof element !== 'object') return null;
  const at = elementPosition(element);
  if (!at) return null;
  const name = tag(element, 'name');
  if (!name) return null;
  const type = String(element.type || 'node');
  const osmId = String(element.id ?? '').trim();
  if (!osmId) return null;
  return {
    id: `${type}/${osmId}`,
    lat: at.lat,
    lon: at.lon,
    label: name,
    meta: {
      category: categoryFor(element.tags),
      kind: kindFor(element.tags),
    },
  };
}

/**
 * Normalize a whole Overpass answer.
 *
 * The same OSM element cannot appear twice in one answer, but a malformed or
 * merged payload could. Unlike railway stations, two same-named places at the
 * same corner are NOT collapsed: a street can hold two pharmacies, and each
 * mapped element is its own place.
 *
 * @param {unknown} elements
 * @returns {{rows:object[], saturated:boolean}}
 */
export function normalizePlaces(elements) {
  if (!Array.isArray(elements)) return { rows: [], saturated: false };
  const saturated = elements.length >= QUERY_LIMIT;
  const rows = [];
  const seen = new Set();
  for (const element of elements.slice(0, QUERY_LIMIT)) {
    const row = normalizePlaceElement(element);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return { rows, saturated };
}
