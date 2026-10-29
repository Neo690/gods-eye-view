/**
 * @module railDepartures
 * @description What the departure board under a mapped station reads.
 *
 * Two datasets, joined: the operator's static GTFS gives every stop an id, a
 * name and a coordinate; the GTFS-Realtime TripUpdates feed gives each running
 * trip the times it now expects to keep. A station is matched by position, not
 * by name — "Nantes" is one OSM node and one SNCF `StopArea`, and only the
 * coordinate says they are the same place.
 *
 * Pure data + pure helpers: imported by the browser card, the server proxy and
 * node:test. No Cesium, no Node built-ins, no clock of its own — every function
 * that needs the time is given it.
 */

/** A station board is a glance, not a timetable: eight is already generous. */
export const RAIL_BOARD_LIMIT = 8;
/** A departure that left more than this ago is not worth a line. */
export const RAIL_BOARD_GRACE_S = 60;
/** How far from a mapped station its SNCF counterpart may sit. */
export const RAIL_STATION_MATCH_KM = 0.8;
/** Longest accepted stops.csv row count; the SNCF file is ~8.8k rows. */
export const RAIL_MAX_STOPS = 40_000;

const finiteCoords = (lat, lon) =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180;

/** Great-circle distance in km; duplicated from geoDistance to stay portable. */
function kmBetween(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Split one CSV row, honouring the quoted fields GTFS allows in names. */
function splitCsvRow(row) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i];
    if (quoted) {
      if (ch === '"' && row[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(value);
      value = '';
    } else value += ch;
  }
  fields.push(value);
  return fields;
}

/**
 * Build the station index from a GTFS `stops.txt`.
 *
 * `StopArea` rows (`location_type=1`) are the stations a board is opened for;
 * `StopPoint` rows are the individual platforms the realtime feed names, and
 * each is mapped back to its parent area. A row without usable coordinates is
 * skipped rather than placed at (0,0).
 *
 * @param {string} text Raw stops.txt contents.
 * @returns {{ areas: object[], areaStops: Map<string, string[]>,
 *   areaById: Map<string, object>, truncated: boolean }}
 */
export function parseGtfsStops(text) {
  const areas = [];
  const areaStops = new Map();
  const areaById = new Map();
  const rows = String(text || '').split('\n');
  if (!rows.length) return { areas, areaStops, areaById, truncated: false };
  const header = splitCsvRow(rows[0].replace(/^\ufeff/, '')).map((name) =>
    name.trim(),
  );
  const col = (name) => header.indexOf(name);
  const idCol = col('stop_id');
  const nameCol = col('stop_name');
  const latCol = col('stop_lat');
  const lonCol = col('stop_lon');
  const typeCol = col('location_type');
  const parentCol = col('parent_station');
  if (idCol < 0 || latCol < 0 || lonCol < 0) {
    throw new TypeError('stops.txt is missing the columns a board needs');
  }
  let truncated = false;
  const pendingChildren = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row.trim()) continue;
    if (areas.length >= RAIL_MAX_STOPS) {
      truncated = true;
      break;
    }
    const fields = splitCsvRow(row);
    const id = (fields[idCol] || '').trim();
    if (!id) continue;
    const lat = Number(fields[latCol]);
    const lon = Number(fields[lonCol]);
    if (!finiteCoords(lat, lon)) continue;
    const name = (fields[nameCol] || '').trim().replace(/^"|"$/g, '');
    const parent = (fields[parentCol] || '').trim();
    const locationType = (fields[typeCol] || '0').trim();
    if (locationType === '1' || (!parent && !locationType)) {
      const area = { id, name, lat, lon };
      areas.push(area);
      areaById.set(id, area);
    } else if (parent) {
      pendingChildren.push([id, parent]);
    }
  }
  for (const [stopId, parent] of pendingChildren) {
    if (!areaById.has(parent)) continue;
    const list = areaStops.get(parent);
    if (list) list.push(stopId);
    else areaStops.set(parent, [stopId]);
  }
  return { areas, areaStops, areaById, truncated };
}

/**
 * The station whose coordinates are closest to a point, or null beyond the
 * match radius. A mapped station with no SNCF counterpart gets no board rather
 * than the nearest one in another region.
 *
 * @param {object[]} areas Station index rows.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [maxKm=RAIL_STATION_MATCH_KM]
 * @returns {{ area: object, distanceKm: number }|null}
 */
export function nearestStation(areas, lat, lon, maxKm = RAIL_STATION_MATCH_KM) {
  if (!Array.isArray(areas) || !finiteCoords(lat, lon)) return null;
  let best = null;
  for (const area of areas) {
    const distanceKm = kmBetween(lat, lon, area.lat, area.lon);
    if (!best || distanceKm < best.distanceKm) best = { area, distanceKm };
  }
  if (!best || best.distanceKm > maxKm) return null;
  return best;
}

/**
 * Turn decoded TripUpdates into the next departures from one station.
 *
 * A trip contributes the stop it reaches in this station — the first one, since
 * a train may pass a platform twice on a loop service. Its destination is the
 * last stop of the trip, named from the static index, and never invented: a
 * trip whose last stop is missing from the index keeps a null destination
 * rather than being labelled with the station it happens to be at.
 *
 * @param {object} input
 * @param {object[]} input.trips Normalized TripUpdates.
 * @param {string} input.areaId Station area id.
 * @param {Map<string, string[]>} input.areaStops Area id → platform stop ids.
 * @param {Map<string, object>} input.areaById Area id → station row.
 * @param {Map<string, string>} [input.stopArea] Stop id → area id, for naming
 *   the last stop of a trip when it is a StopArea itself.
 * @param {number} input.now Epoch seconds.
 * @param {number} [input.limit=RAIL_BOARD_LIMIT]
 * @param {number} [input.graceS=RAIL_BOARD_GRACE_S]
 * @returns {{ departures: object[], considered: number, truncated: boolean }}
 */
export function buildStationBoard({
  trips,
  areaId,
  areaStops,
  areaById,
  stopArea = new Map(),
  now,
  limit = RAIL_BOARD_LIMIT,
  graceS = RAIL_BOARD_GRACE_S,
}) {
  if (!Array.isArray(trips) || !areaId || !Number.isFinite(now)) {
    return { departures: [], considered: 0, truncated: false };
  }
  const stopIds = areaStops.get(areaId) || [];
  const origins = new Set([areaId, ...stopIds]);
  const departures = [];
  let considered = 0;
  let truncated = false;
  for (const trip of trips) {
    if (!trip || !Array.isArray(trip.stops) || !trip.stops.length) continue;
    if (trip.truncated) truncated = true;
    const stop = trip.stops.find((entry) => origins.has(entry.stopId));
    if (!stop) continue;
    considered += 1;
    // A departure, not an arrival: a train terminating here is not going
    // anywhere and a board that listed it would be lying about direction.
    const last = trip.stops[trip.stops.length - 1];
    if (last === stop || last.stopId === stop.stopId) continue;
    const at = stop.departureTime ?? stop.arrivalTime;
    if (!Number.isFinite(at)) continue;
    if (at < now - graceS) continue;
    const destinationArea = stopArea.get(last.stopId) || last.stopId;
    const destination = areaById.get(destinationArea)?.name || null;
    departures.push({
      at,
      expectedAt:
        Number.isFinite(stop.delay) && stop.delay !== 0 ? at + stop.delay : at,
      delaySeconds: Number.isFinite(stop.delay) ? stop.delay : null,
      destination,
      cancelled: trip.cancelled === true || stop.skipped === true,
      routeId: trip.routeId || null,
      tripId: trip.tripId || null,
    });
  }
  departures.sort((a, b) => a.expectedAt - b.expectedAt || a.at - b.at);
  return {
    departures: departures.slice(0, Math.max(0, limit)),
    considered,
    truncated,
  };
}
