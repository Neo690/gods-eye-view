/**
 * @module layers/osmPlaces/policy
 * @description Constants and pure decisions for the OpenStreetMap Places
 * layer: named POIs read through the app's own Overpass proxy. No Cesium, no
 * network — everything here is exercised by node:test.
 *
 * The data is community-mapped OpenStreetMap (ODbL), not a business directory:
 * a place here is a mapped feature, not a claim that it is open, current or
 * still there.
 */

export const LAYER_ID = 'osm-places';

/** The app's own Overpass proxy — never a public mirror, never a client URL. */
export const OVERPASS_URL = '/api/overpass';

/**
 * Result cap. A city view holds thousands of named places; the cap exists so
 * one query cannot return a region's whole directory.
 */
export const QUERY_LIMIT = 800;

/**
 * Widest view asked of Overpass, in degrees per axis. Beyond this the box is
 * clamped to the middle of the view: a places layer at country zoom would
 * otherwise ask a mirror for continent-scale work, which the proxy refuses.
 */
export const MAX_VIEWPORT_DEGREES = 2;

/** Overpass QL timeout, under the proxy's 30 s clamp. */
export const QUERY_TIMEOUT_S = 25;

/** How often the layer asks again while the camera stays still. */
export const REFRESH_MS = 300_000;

/**
 * The editor this layer links to for the same query: tyrasd/overpass-turbo
 * (MIT), hosted at overpass-turbo.eu. Linked, never bundled.
 */
export const OVERPASS_TURBO_URL = 'https://overpass-turbo.eu/';

/**
 * The tag families that make a named feature a place worth drawing. A single
 * selector per family keeps each statement individually bounded, which is
 * what the proxy's static validator requires.
 */
export const PLACE_SELECTORS = Object.freeze([
  'nwr["name"]["amenity"]',
  'nwr["name"]["shop"]',
  'nwr["name"]["tourism"]',
  'nwr["name"]["historic"]',
  'nwr["name"]["leisure"]',
  'nwr["name"]["office"]',
  'nwr["name"]["craft"]',
]);

/** Marker palette: one colour per family, so a row of dots reads as a city. */
export const CATEGORY_COLOURS = Object.freeze({
  food: '#FFB347',
  shop: '#7FE7C4',
  culture: '#C9A7FF',
  services: '#8FD3FF',
  other: '#D7DEE8',
});

const FOOD_AMENITIES = new Set([
  'restaurant',
  'cafe',
  'bar',
  'pub',
  'fast_food',
  'food_court',
  'ice_cream',
  'biergarten',
]);

/** Trimmed tag value, or null. */
function tag(tags, key) {
  const text = String(tags?.[key] ?? '').trim();
  return text || null;
}

/**
 * Four-decimal Overpass bbox for a bounded view.
 *
 * @param {{south:number, west:number, north:number, east:number}} box
 * @returns {string}
 */
export function overpassBbox(box) {
  const { south, west, north, east } = box || {};
  if (![south, west, north, east].every(Number.isFinite))
    throw new TypeError('A bounded viewport is required');
  if (north <= south || east <= west)
    throw new TypeError('A bounded viewport is required');
  return [south, west, north, east]
    .map((value) => Number(value).toFixed(5))
    .join(',');
}

/**
 * Bounded Overpass QL for one view.
 *
 * Each selector sits in the same union block. Written as bare statements they
 * would chain (each filters the previous result), yielding nothing; the union
 * asks the mirror for the union of every family.
 *
 * @param {{south:number, west:number, north:number, east:number}} box Degrees.
 * @returns {string} Overpass QL, safe for the proxy's bounded-query rules.
 */
export function osmPlacesQuery(box) {
  const bbox = overpassBbox(box);
  return (
    `[out:json][timeout:${QUERY_TIMEOUT_S}];` +
    `(${PLACE_SELECTORS.map((selector) => `${selector}(${bbox});`).join('')});` +
    `out center ${QUERY_LIMIT};`
  );
}

/**
 * The same query for Overpass Turbo, with its `{{bbox}}` shortcut left for the
 * editor to expand from the map view the link opens.
 *
 * @returns {string}
 */
export function overpassTurboQuery() {
  return (
    `[out:json][timeout:${QUERY_TIMEOUT_S}];` +
    `(${PLACE_SELECTORS.map((selector) => `${selector}({{bbox}});`).join('')});` +
    `out center ${QUERY_LIMIT};`
  );
}

/** Web-Mercator zoom that shows roughly `span` degrees across a desktop view. */
export function turboZoomForSpan(span) {
  const degrees = Number(span);
  if (!Number.isFinite(degrees) || degrees <= 0) return 15;
  return Math.max(2, Math.min(17, Math.round(Math.log2(1440 / degrees))));
}

/**
 * Overpass Turbo permalink for a view: the query, the map centre and zoom, and
 * the instruction to run it on load.
 *
 * @param {{south:number, west:number, north:number, east:number}|null} box
 * @returns {string|null} Null when the view is not a real rectangle.
 */
export function overpassTurboUrl(box) {
  const { south, west, north, east } = box || {};
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (north <= south || east <= west) return null;
  const lat = (south + north) / 2;
  const lon = (west + east) / 2;
  const zoom = turboZoomForSpan(Math.max(north - south, east - west));
  const query = encodeURIComponent(overpassTurboQuery());
  return `${OVERPASS_TURBO_URL}?Q=${query}&C=${lat.toFixed(5)};${lon.toFixed(5)};${zoom}&R`;
}

/**
 * Which family a mapped place belongs to.
 *
 * The order is deliberate: a restaurant inside a hotel is a place to eat
 * first, and an amenity with no food meaning is a service. `office` and
 * `craft` only reach `other` when no stronger family is present.
 *
 * @param {object|null} tags OSM tags.
 * @returns {'food'|'shop'|'culture'|'services'|'other'}
 */
export function categoryFor(tags) {
  const amenity = tag(tags, 'amenity');
  if (amenity) return FOOD_AMENITIES.has(amenity) ? 'food' : 'services';
  if (tag(tags, 'shop')) return 'shop';
  if (tag(tags, 'tourism') || tag(tags, 'historic') || tag(tags, 'leisure'))
    return 'culture';
  return 'other';
}

/**
 * The OSM tag value that names what the place is, e.g. `cafe` or `museum`.
 *
 * @param {object|null} tags OSM tags.
 * @returns {string}
 */
export function kindFor(tags) {
  return (
    tag(tags, 'amenity') ||
    tag(tags, 'shop') ||
    tag(tags, 'tourism') ||
    tag(tags, 'historic') ||
    tag(tags, 'leisure') ||
    tag(tags, 'office') ||
    tag(tags, 'craft') ||
    'place'
  );
}
