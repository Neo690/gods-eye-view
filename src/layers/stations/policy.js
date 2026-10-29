/**
 * @module layers/stations/policy
 * @description Constants and pure decisions for the Railway Stations layer:
 * OpenStreetMap `railway=station` nodes and ways, read through the app's own
 * Overpass proxy. No Cesium, no network — everything here is exercised by
 * node:test.
 *
 * The data is community-mapped OpenStreetMap (ODbL), not an operator feed: a
 * station here is a mapped place, not a live service. Nothing in this layer
 * claims a train is there.
 */

export const LAYER_ID = 'railway-stations';

/** The app's own Overpass proxy — never a public mirror, never a client URL. */
export const OVERPASS_URL = '/api/overpass';

/**
 * Result cap. A regional view of a dense country holds a few hundred stations;
 * the cap exists so one query can never return a country's whole network.
 */
export const QUERY_LIMIT = 1200;

/**
 * Widest view asked of Overpass, in degrees per axis. Beyond this the box is
 * clamped to the middle of the view: a station layer at world zoom would
 * otherwise ask a mirror for planet-scale work, which the proxy refuses.
 */
export const MAX_VIEWPORT_DEGREES = 6;

/** Overpass QL timeout, under the proxy's 30 s clamp. */
export const QUERY_TIMEOUT_S = 25;

/** How often the layer asks for the current view (the data itself is static). */
export const POLL_MS = 180_000;

/**
 * How often an open departure board asks again.
 *
 * The server holds its realtime snapshot for 45 s, so a minute is the shortest
 * interval that can return anything new. Without it, a board would freeze at
 * the moment the card was opened and go on calling those trains "next".
 */
export const BOARD_REFRESH_MS = 60_000;

/**
 * Camera drift tolerated before refetching. Moving a fifth of a degree is a
 * city block at the zooms this layer is read at; below it the same stations
 * already loaded are still the right answer.
 */
export const REFETCH_MIN_DEG = 0.02;

/** Ambient station labels drawn at once, and the collision budget they share. */
export const LABEL_COHORT_LIMIT = 64;
export const LABEL_COLLISION_CAPACITY = 32;

/** Marker palette: infrastructure, deliberately unlike every transit mode. */
export const STATION_COLOR = '#8FD3FF';
export const STATION_SELECTED_COLOR = '#FFFFFF';
export const STATION_PIXEL_SIZE = 7;

/** Overlay source id for ambient labels. */
export const STATION_OVERLAY_SOURCE_ID = 'railway-stations';

/** Overlay source id for the one selected station's card. */
export const STATION_SELECTED_OVERLAY_SOURCE_ID = 'railway-stations-selected';

/** One card at a time, never collided away. */
export const STATION_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});

/** Entity ids are namespaced so a pick can tell whose dot was clicked. */
export const STATION_ENTITY_PREFIX = `${LAYER_ID}:`;

/** Selected marker: larger and brighter than the drawn station. */
export const STATION_SELECTED_PIXEL_SIZE = 14;

/**
 * Build the bounded Overpass QL for a view box.
 *
 * Stations are mapped as nodes in most of the world and as ways (the station
 * building or area) in some, so both are asked for and both come back through
 * `out center`, which gives every way a coordinate.
 *
 * The two selectors MUST sit in a union block. Written as two bare statements
 * they chain instead: each query statement filters the previous statement's
 * result, so `node[…]` then `way[…]` asks for ways among nodes and yields
 * nothing at all — measured against a local Overpass, where the same pair
 * returned 65 stations inside `( … )` and 0 outside it.
 *
 * @param {{south:number, west:number, north:number, east:number}} box Degrees.
 * @returns {string} Overpass QL, safe for the proxy's bounded-query rules.
 */
export function stationsQuery(box) {
  const bbox = [box.south, box.west, box.north, box.east]
    .map((value) => Number(value).toFixed(5))
    .join(',');
  return (
    `[out:json][timeout:${QUERY_TIMEOUT_S}];` +
    `(node["railway"="station"](${bbox});` +
    `way["railway"="station"](${bbox}););` +
    `out center ${QUERY_LIMIT};`
  );
}

/**
 * Clamp a view box to the widest ask this layer makes, keeping its centre.
 *
 * A view wider than MAX_VIEWPORT_DEGREES still gets its middle read rather than
 * nothing: the stations drawn are then real and simply local to the centre,
 * which is honest — unlike an empty map that would read as "no stations here".
 *
 * @param {{south:number, west:number, north:number, east:number}|null} box
 * @returns {{south:number, west:number, north:number, east:number}|null}
 */
export function clampViewport(box) {
  if (!box) return null;
  const { south, west, north, east } = box;
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (north <= south || east <= west) return null;
  const clampAxis = (low, high) => {
    const span = high - low;
    if (span <= MAX_VIEWPORT_DEGREES) return [low, high];
    const middle = (low + high) / 2;
    const half = MAX_VIEWPORT_DEGREES / 2;
    return [middle - half, middle + half];
  };
  const [clampedSouth, clampedNorth] = clampAxis(south, north);
  const [clampedWest, clampedEast] = clampAxis(west, east);
  return {
    south: Math.max(-90, clampedSouth),
    north: Math.min(90, clampedNorth),
    west: clampedWest,
    east: clampedEast,
  };
}

/**
 * How far a view box moved from the one already loaded, in degrees: the larger
 * of the two axis changes. Used to ignore camera jitter.
 *
 * @param {{south:number, west:number, north:number, east:number}|null} previous
 * @param {{south:number, west:number, north:number, east:number}|null} next
 * @returns {number} Infinity when either box is missing, so a first load always runs.
 */
export function viewportDelta(previous, next) {
  if (!previous || !next) return Infinity;
  return Math.max(
    Math.abs(previous.south - next.south),
    Math.abs(previous.north - next.north),
    Math.abs(previous.west - next.west),
    Math.abs(previous.east - next.east),
  );
}

/**
 * Whether the current view is worth a new query.
 *
 * @param {{south:number, west:number, north:number, east:number}|null} previous
 * @param {{south:number, west:number, north:number, east:number}|null} next
 * @param {boolean} [haveRecords=false] False until a first load has succeeded.
 * @returns {boolean}
 */
export function shouldRefetch(previous, next, haveRecords = false) {
  if (!next) return false;
  if (!haveRecords) return true;
  return viewportDelta(previous, next) > REFETCH_MIN_DEG;
}

/**
 * Priority for an ambient label: a main-line station outranks a halt, so a
 * country's label budget is spent on the stations a reader is looking for.
 *
 * @param {{usage:string|null}} record
 * @returns {number}
 */
export function stationPriority(record) {
  if (record?.usage === 'main') return 1000;
  if (record?.usage === 'branch') return 500;
  return 100;
}

/**
 * Build the presentation for one ambient station label.
 *
 * @param {{id:string, position:object, name:string, usage:string|null}} input
 * @returns {object}
 */
export function createStationOverlayEntry({ id, position, name, usage }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title: String(name),
    accent: STATION_COLOR,
    priority: stationPriority({ usage }),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/**
 * Keep the most significant labels, with stable identity as the tie-break.
 *
 * @param {object[]} entries
 * @param {number} [limit=LABEL_COHORT_LIMIT]
 * @returns {object[]}
 */
export function selectStationCohort(entries, limit = LABEL_COHORT_LIMIT) {
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
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
 * The station id behind a picked entity id, or null when the pick is not one of
 * this layer's stations.
 *
 * Entity ids are namespaced (`railway-stations:node/271234`) so a click can be
 * attributed to this layer without guessing from the raw OSM id.
 *
 * @param {string|null} pickedId Canonical pick id.
 * @returns {string|null} The station record id, prefix removed.
 */
export function stationIdFromPick(pickedId) {
  if (typeof pickedId !== 'string') return null;
  if (!pickedId.startsWith(STATION_ENTITY_PREFIX)) return null;
  const id = pickedId.slice(STATION_ENTITY_PREFIX.length);
  return id || null;
}

/** English {placeholder} interpolation, the default `t` of the card copy. */
function englishText(text, values) {
  if (!values) return text;
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (literal, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : literal,
  );
}

/**
 * Build the human lines of the selected station's card.
 *
 * Only what the map actually records is said: a station with no operator tag
 * gets no operator line, rather than "unknown" printed under its name. The
 * provenance line is always last and always present, because a mapped place is
 * not a live service and the card must not be read as one.
 *
 * @param {object} record Station record.
 * @param {(text: string, values?: object) => string} [t] Translates the card's
 *   English text; English when omitted.
 * @returns {{title:string, details:string[]}}
 */
export function buildStationSelectionCopy(
  record,
  t = englishText,
  board = null,
) {
  const details = [];
  const operator = String(record?.operator || '').trim();
  const network = String(record?.network || '').trim();
  if (operator) details.push(t('Operator {operator}', { operator }));
  if (network) details.push(t('Network {network}', { network }));
  if (Number.isFinite(record?.platforms) && record.platforms > 0) {
    details.push(t('Platforms {count}', { count: record.platforms }));
  }
  if (board) {
    for (const line of buildStationDepartureLines(board, t)) details.push(line);
  }
  // A station with a live board is not "not a live service" any more: the
  // provenance line says which of the two it is.
  details.push(
    board
      ? t('Mapped in OpenStreetMap · departures from SNCF (ODbL)')
      : t('Mapped in OpenStreetMap · not a live service'),
  );
  return { title: String(record?.name || ''), details };
}

/** Two-digit local clock time for one epoch second. */
function clockTime(epochSeconds) {
  const date = new Date(epochSeconds * 1000);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Render a departure board as card lines.
 *
 * Each line is the time the train now expects to leave, then where it goes,
 * then its state — late, on time, or cancelled. A destination the operator
 * does not name stays unnamed rather than becoming the origin station, and a
 * board with nothing on it says so in one line instead of an empty heading.
 *
 * @param {object} board Payload from `/api/rail/departures`.
 * @param {(text: string, values?: object) => string} [t]
 * @returns {string[]}
 */
export function buildStationDepartureLines(board, t = englishText) {
  const departures = Array.isArray(board?.departures) ? board.departures : [];
  if (!departures.length) return [t('No departures expected')];
  const lines = [t('Next departures')];
  for (const departure of departures) {
    if (!Number.isFinite(departure?.expectedAt)) continue;
    const at = clockTime(departure.expectedAt);
    const destination = String(departure.destination || '').trim();
    const state = departure.cancelled
      ? t('cancelled')
      : Number.isFinite(departure.delaySeconds) && departure.delaySeconds >= 60
        ? t('{minutes} min late', {
            minutes: Math.round(departure.delaySeconds / 60),
          })
        : t('on time');
    lines.push(
      destination ? `${at} → ${destination} · ${state}` : `${at} · ${state}`,
    );
  }
  return lines.length > 1 ? lines : [t('No departures expected')];
}

/**
 * The protected card for the selected station.
 *
 * @param {string} key Station record id.
 * @param {object} position Cesium position of the station.
 * @param {{title:string, details:string[]}} copy
 * @returns {object|null}
 */
export function createStationSelectedOverlayEntry(key, position, copy) {
  if (!key || !position) return null;
  return {
    id: String(key),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title: copy.title,
    details: copy.details,
    accent: STATION_SELECTED_COLOR,
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 11,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}
