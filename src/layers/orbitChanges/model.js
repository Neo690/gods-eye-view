/**
 * Orbit-change detection from successive CelesTrak element sets.
 *
 * The technique is the one every manoeuvre tracker uses, because it is the only
 * one available from public data: a TLE is a fitted orbit, so when a satellite
 * fires its engine the next element set no longer matches the previous one
 * after drag and the usual perturbations are accounted for. Comparing the two
 * sets' semi-major axis, inclination and eccentricity therefore says "this orbit
 * changed" — never "this satellite manoeuvred on purpose", which is why the
 * card says inferred and the copy never claims a burn.
 *
 * Pure: no Cesium, no DOM, no network. The sub-satellite point is the one place
 * SGP4 is needed, and it is computed from the element set that reported the
 * change, at that set's own epoch — where the object actually was, not where a
 * guess would put it now.
 *
 * @module layers/orbitChanges/model
 */
import { eciToGeodetic, gstime, propagate, twoline2satrec } from 'satellite.js';

/** Catalog id; also the ambient-card source. */
export const ORBIT_CHANGE_LAYER_ID = 'orbit-changes';

/** Never paint more ambient labels than this, whatever the feed holds. */
export const ORBIT_CHANGE_OVERLAY_COHORT_LIMIT = 40;
export const ORBIT_CHANGE_OVERLAY_COLLISION_CAPACITY = 20;

/**
 * The groups compared. Astrodynamics is the point here, not constellation
 * size: GEO is where station-keeping burns are routine and visible, the station
 * list is small and followed by everybody, and `visual` adds the bright LEO
 * objects without dragging in 10 000 Starlink element sets on a phone.
 */
export const ORBIT_CHANGE_GROUPS = Object.freeze(['geo', 'stations', 'visual']);

/** Where the previous element sets are remembered between sessions. */
export const ORBIT_CHANGE_BASELINE_STORAGE_KEY = 'gev.orbit-baseline.v1';

/**
 * A change smaller than this is what a refit looks like. The thresholds are
 * deliberately generous: a false "orbit changed" is a wasted click, and the
 * card says the figure is an estimate.
 */
export const ORBIT_CHANGE_THRESHOLDS = Object.freeze({
  altitudeKm: 1.5,
  inclinationDeg: 0.02,
  eccentricity: 0.0002,
});

/** Earth's gravitational parameter, km³/s². */
const MU = 398600.4418;
/** Mean Earth radius, km — the same sphere the app draws markers on. */
const EARTH_RADIUS_KM = 6371;

/**
 * Epoch of a TLE, in milliseconds. Line 1 columns 19-32 hold YYDDD.DDDDDDDD.
 * @param {string} line1
 * @returns {number|null}
 */
export function tleEpochMs(line1) {
  const stamp = String(line1 || '')
    .slice(18, 32)
    .trim();
  const match = /^(\d{2})(\d{3})\.(\d+)$/.exec(stamp);
  if (!match) return null;
  const year = Number(match[1]);
  // TLE years are two digits from 1957; the pivot keeps 57-99 in the 1900s.
  const fullYear = year < 57 ? 2000 + year : 1900 + year;
  const dayOfYear = Number(match[2]);
  const fraction = Number(`0.${match[3]}`);
  const ms = Date.UTC(fullYear, 0, 1) + (dayOfYear - 1 + fraction) * 86400000;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The three elements a manoeuvre shows up in, from line 2's fixed columns.
 * @param {string} line2
 * @returns {{inclinationDeg:number, raanDeg:number, eccentricity:number, meanMotion:number}|null}
 */
export function parseTleElements(line2) {
  const text = String(line2 || '');
  if (!text.startsWith('2 ')) return null;
  const inclinationDeg = Number(text.slice(8, 16));
  const raanDeg = Number(text.slice(17, 25));
  const eccentricity = Number(`0.${text.slice(26, 33).trim()}`);
  const meanMotion = Number(text.slice(52, 63));
  for (const value of [inclinationDeg, raanDeg, eccentricity, meanMotion]) {
    if (!Number.isFinite(value)) return null;
  }
  if (meanMotion <= 0) return null;
  return { inclinationDeg, raanDeg, eccentricity, meanMotion };
}

/** Semi-major axis in km from a mean motion in revolutions per day. */
export function semiMajorAxisKm(meanMotion) {
  const n = (Number(meanMotion) * 2 * Math.PI) / 86400;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.cbrt(MU / (n * n));
}

/** Circular-orbit speed in km/s at that semi-major axis. */
function circularSpeedKmS(semiMajorAxis) {
  return Math.sqrt(MU / semiMajorAxis);
}

/**
 * Read a CelesTrak `FORMAT=tle` body into one entry per object.
 * @param {string} text
 * @returns {Array<{norad:string,name:string,line1:string,line2:string,elements:object,epochMs:number}>}
 */
export function parseTleCatalog(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const entries = [];
  for (let index = 0; index < lines.length; index++) {
    const name = lines[index];
    const line1 = lines[index + 1];
    const line2 = lines[index + 2];
    if (
      !name?.startsWith('1 ') &&
      line1?.startsWith('1 ') &&
      line2?.startsWith('2 ')
    ) {
      const norad = line1.slice(2, 7).trim();
      const elements = parseTleElements(line2);
      const epochMs = tleEpochMs(line1);
      if (norad && elements && epochMs) {
        entries.push({ norad, name, line1, line2, elements, epochMs });
      }
      index += 2;
    }
  }
  return entries;
}

/**
 * The baseline a session keeps: identity and the three compared elements only,
 * never the element lines, so a few hundred objects still fit localStorage on
 * a phone.
 * @param {ReturnType<typeof parseTleCatalog>} entries
 * @param {number} [at] - When the baseline was taken.
 * @returns {object}
 */
export function baselineFromCatalog(entries, at = Date.now()) {
  const objects = {};
  for (const entry of entries) {
    objects[entry.norad] = {
      name: entry.name,
      epochMs: entry.epochMs,
      meanMotion: entry.elements.meanMotion,
      inclinationDeg: entry.elements.inclinationDeg,
      eccentricity: entry.elements.eccentricity,
    };
  }
  return { at, objects };
}

/**
 * Where one element set puts the object, at that set's epoch.
 * @param {string} line1
 * @param {string} line2
 * @returns {{lat:number, lon:number}|null}
 */
export function subSatellitePoint(line1, line2) {
  try {
    const satrec = twoline2satrec(line1, line2);
    const epochMs = tleEpochMs(line1);
    if (!epochMs) return null;
    const state = propagate(satrec, new Date(epochMs));
    if (!state?.position) return null;
    const geodetic = eciToGeodetic(state.position, gstime(new Date(epochMs)));
    const lat = (geodetic.latitude * 180) / Math.PI;
    const lon = (geodetic.longitude * 180) / Math.PI;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } catch {
    return null;
  }
}

/**
 * Compare one group's fresh element sets with the previous baseline.
 *
 * An object missing from either side is skipped rather than reported: a launch
 * or a decay is not a manoeuvre, and saying so would be the one claim this
 * layer must not make.
 *
 * @param {object} previous `baselineFromCatalog` output.
 * @param {ReturnType<typeof parseTleCatalog>} current
 * @param {object} [thresholds]
 * @returns {object[]} one event per changed object.
 */
export function orbitalChanges(
  previous,
  current,
  thresholds = ORBIT_CHANGE_THRESHOLDS,
) {
  const before = previous?.objects || {};
  const events = [];
  for (const entry of current) {
    const old = before[entry.norad];
    if (!old) continue;
    // The same element set seen twice is not a change.
    if (
      old.epochMs === entry.epochMs &&
      old.meanMotion === entry.elements.meanMotion
    )
      continue;

    const aOld = semiMajorAxisKm(old.meanMotion);
    const aNew = semiMajorAxisKm(entry.elements.meanMotion);
    if (!aOld || !aNew) continue;
    const deltaAltitudeKm = aNew - aOld;
    const deltaInclinationDeg =
      entry.elements.inclinationDeg - old.inclinationDeg;
    const deltaEccentricity = entry.elements.eccentricity - old.eccentricity;

    const big = Math.abs(deltaAltitudeKm) >= thresholds.altitudeKm;
    const tilted = Math.abs(deltaInclinationDeg) >= thresholds.inclinationDeg;
    const shaped = Math.abs(deltaEccentricity) >= thresholds.eccentricity;
    if (!big && !tilted && !shaped) continue;

    // Along-track burn estimate from the energy change, plus the speed a plane
    // change of that size would cost. An estimate, and the card says so.
    const vOld = circularSpeedKmS(aOld);
    const vNew = circularSpeedKmS(aNew);
    const deltaVMps =
      (Math.abs(vNew - vOld) +
        vNew * Math.abs(deltaInclinationDeg) * (Math.PI / 180)) *
      1000;

    const point = subSatellitePoint(entry.line1, entry.line2);
    if (!point) continue;
    events.push({
      id: entry.norad,
      norad: entry.norad,
      name: entry.name,
      epoch: entry.epochMs,
      previousEpoch: old.epochMs,
      lat: point.lat,
      lon: point.lon,
      altitudeKm: aNew - EARTH_RADIUS_KM,
      deltaAltitudeKm,
      deltaInclinationDeg,
      deltaEccentricity,
      deltaVMps,
      priority: Math.round(deltaVMps * 10) + (big ? 40 : 0),
    });
  }
  events.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  return events;
}

/** Colour a marker by how big the change was: dimmer means smaller. */
export function orbitChangeAccent(deltaVMps) {
  const value = Number(deltaVMps);
  if (!Number.isFinite(value) || value < 5) return '#F6AD55';
  if (value < 30) return '#F6E05E';
  return '#FC8181';
}

/**
 * One ambient label per event: the satellite's name and the estimated cost.
 * @param {object} event
 * @param {{x:number,y:number,z:number}} position
 * @param {function(string):string} [translate]
 * @returns {object}
 */
export function createOrbitChangeOverlayEntry(
  event,
  position,
  translate = (text) => text,
) {
  return {
    id: String(event.id),
    position,
    variant: 'label',
    title: String(event.name),
    details: [`${translate('~')}${Math.round(event.deltaVMps)} m/s`],
    accent: orbitChangeAccent(event.deltaVMps),
    priority: event.priority,
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

/** Keep the costliest changes, with a stable tie-break. */
export function selectOrbitChangeCohort(entries, limit) {
  const cap = Math.max(
    0,
    Math.min(
      ORBIT_CHANGE_OVERLAY_COHORT_LIMIT,
      Math.floor(Number(limit ?? ORBIT_CHANGE_OVERLAY_COHORT_LIMIT) || 0),
    ),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/** Compact epoch, for a card line that has one line. */
export function formatEpoch(ms) {
  if (!Number.isFinite(ms)) return '';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}
