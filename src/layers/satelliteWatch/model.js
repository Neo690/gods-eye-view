/**
 * One satellite layer, four independently switchable sources.
 *
 * The four sites this module answers to do not all publish data: Azmth and War
 * Monitor are applications over public element sets, and Orbital Radar's
 * manoeuvre tracker serves its own token-gated API (its `/api/m/…` answers 403
 * without a token and its robots.txt reserves TDM rights). What this module
 * shows is therefore the *public* flux each one is built on — CelesTrak element
 * sets, the keyless TLE catalogue — plus, for Orbital Radar, the same
 * successive-element-set diff that site's tracker performs. Every row names the
 * real flux. N2YO is the exception: it publishes a real API, and that source
 * reads it with the operator's own key.
 *
 * Pure: satellite.js for propagation, no Cesium, no DOM, no network.
 * @module layers/satelliteWatch/model
 */
import { eciToGeodetic, gstime, propagate, twoline2satrec } from 'satellite.js';
import { msg } from '../../i18n/marker.js';
import { parseTleCatalog } from '../orbitChanges/model.js';

/** Layer id; also the overlay source the labels are published under. */
export const SATELLITE_WATCH_LAYER_ID = 'satellite-watch';

/** Where the Orbital Radar source remembers its previous element sets. */
export const SATELLITE_WATCH_BASELINE_KEY = 'gev.satellite-watch.baseline.v1';

/**
 * The CelesTrak groups read for Azmth and Orbital Radar. `active` is 25 000
 * objects and 2.7 MB; these four groups are the same population a globe can
 * show, and the Satellites layer already keeps them warm in the proxy cache.
 */
export const WATCH_CATALOG_GROUPS = Object.freeze([
  'stations',
  'visual',
  'geo',
  'gps-ops',
]);

/** Pages of 20 objects read from the keyless TLE catalogue. */
export const WATCH_TLE_API_PAGES = 3;

/**
 * How many objects each source may paint. A phone cannot draw 25 000 points,
 * and a globe with every catalogue object on it answers no question.
 */
export const WATCH_SOURCE_CAPS = Object.freeze({
  azmth: 900,
  'orbital-radar': 24,
  'war-monitor': 160,
  'space-track': 900,
  n2yo: 400,
});

/** The switches, in the order the row shows them. */
export const WATCH_SOURCES = Object.freeze([
  Object.freeze({
    id: 'azmth',
    // i18n-ignore: product name
    label: 'Azmth',
    color: '#7FD1FF',
  }),
  Object.freeze({
    id: 'orbital-radar',
    // i18n-ignore: product name
    label: 'Orbital Radar',
    color: '#F6AD55',
  }),
  Object.freeze({
    id: 'war-monitor',
    // i18n-ignore: product name
    label: 'War Monitor',
    color: '#FC8181',
  }),
  Object.freeze({
    id: 'space-track',
    // i18n-ignore: product name
    label: 'Space-Track',
    color: '#B794F4',
  }),
  Object.freeze({
    id: 'n2yo',
    // i18n-ignore: product name
    label: 'N2YO',
    color: '#9AE6B4',
  }),
]);

export function watchSource(id) {
  return WATCH_SOURCES.find((source) => source.id === id) || null;
}

/**
 * Orbit regime from altitude and eccentricity. `HEO` is the honest bucket for a
 * highly elliptical orbit, which no single altitude describes.
 */
export function orbitRegime(altitudeKm, eccentricity = 0) {
  const altitude = Number(altitudeKm);
  if (!Number.isFinite(altitude)) return 'UNKNOWN';
  if (altitude < 0) return 'SUB';
  if (Number(eccentricity) > 0.25) return 'HEO';
  if (altitude < 2000) return 'LEO';
  if (altitude < 35000) return 'MEO';
  return 'GEO';
}

/** A deterministic, evenly spaced subset — never the first N in file order. */
export function sampleEvenly(list, cap) {
  if (!Array.isArray(list) || !list.length) return [];
  const limit = Math.max(0, Math.floor(Number(cap) || 0));
  if (limit === 0) return [];
  if (list.length <= limit) return list.slice();
  const stride = list.length / limit;
  const out = [];
  for (let index = 0; index < limit; index++) {
    out.push(list[Math.floor(index * stride)]);
  }
  return out;
}

/**
 * Where one element set puts the object at `date`.
 * @param {string} line1
 * @param {string} line2
 * @param {Date} date
 * @returns {{lat:number, lon:number, altitudeKm:number}|null}
 */
export function positionAt(line1, line2, date) {
  try {
    const satrec = twoline2satrec(line1, line2);
    if (!satrec || satrec.error) return null;
    const state = propagate(satrec, date);
    if (!state?.position) return null;
    const geodetic = eciToGeodetic(state.position, gstime(date));
    const lat = (geodetic.latitude * 180) / Math.PI;
    const lon = (geodetic.longitude * 180) / Math.PI;
    const altitudeKm = geodetic.height;
    if (![lat, lon, altitudeKm].every(Number.isFinite)) return null;
    if (Math.abs(lat) > 90) return null;
    return { lat, lon, altitudeKm };
  } catch {
    return null;
  }
}

/** One marker record. `at` is the propagation instant, not the TLE epoch. */
function record(source, norad, name, position, at, eccentricity) {
  return {
    id: `${source}:${norad}`,
    source,
    norad: String(norad),
    name: String(name || norad),
    lat: position.lat,
    lon: position.lon,
    altitudeKm: position.altitudeKm,
    regime: orbitRegime(position.altitudeKm, eccentricity),
    at,
  };
}

/**
 * Azmth / Orbital Radar: positions from CelesTrak element sets at `date`.
 * @param {Array<object>} entries `parseTleCatalog` output.
 * @param {Date} date
 * @param {number} cap
 */
export function fromCatalogEntries(entries, date, cap) {
  const sampled = sampleEvenly(entries, cap);
  const objects = [];
  for (const entry of sampled) {
    const position = positionAt(entry.line1, entry.line2, date);
    if (!position) continue;
    objects.push(
      record(
        'azmth',
        entry.norad,
        entry.name,
        position,
        date.getTime(),
        entry.elements?.eccentricity,
      ),
    );
  }
  return objects;
}

/**
 * War Monitor: positions from the keyless TLE catalogue's 20-per-page member
 * list.
 * @param {Array<object>} members
 * @param {Date} date
 * @param {number} cap
 */
export function fromTleApiMembers(members, date, cap) {
  const sampled = sampleEvenly(
    (members || []).filter((member) => member?.line1 && member?.line2),
    cap,
  );
  const objects = [];
  for (const member of sampled) {
    const position = positionAt(member.line1, member.line2, date);
    if (!position) continue;
    objects.push(
      record(
        'war-monitor',
        member.satelliteId,
        member.name,
        position,
        date.getTime(),
      ),
    );
  }
  return objects;
}

/** N2YO: the API already gives the sub-satellite point and altitude. */
/**
 * Space-Track: the official element sets behind the same propagation as the
 * Azmth source. `entries` are the proxy's parsed TLE triples.
 * @param {Array<object>} entries
 * @param {Date} date
 * @param {number} cap
 */
export function fromSpaceTrackGp(entries, date, cap) {
  const sampled = sampleEvenly(entries, cap);
  const objects = [];
  for (const entry of sampled) {
    if (!entry?.line1 || !entry?.line2) continue;
    const position = positionAt(entry.line1, entry.line2, date);
    if (!position) continue;
    objects.push(
      record(
        'space-track',
        entry.norad,
        entry.name || entry.norad,
        position,
        date.getTime(),
      ),
    );
  }
  return objects;
}

/**
 * One public CDM row, normalised. Space-Track returns upper-case keys in the
 * documented JSON; lower-case variants are accepted so a format change costs a
 * field, not the layer.
 * @returns {{id:string, tca:number, primaryId:string, primaryName:string,
 *   secondaryId:string, secondaryName:string, minRangeKm:number,
 *   pc:number, relativeSpeedKmS:number}|null}
 */
export function parseCdmMessage(row) {
  if (!row || typeof row !== 'object') return null;
  const pick = (...names) => {
    for (const name of names) {
      const value = row[name] ?? row[name.toLowerCase()];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  };
  const tcaRaw = pick('TCA', 'tca');
  // "2026-05-03 14:22:33" is UTC, with no zone marker to read; an answer that
  // already carries one is taken as written.
  const tcaText =
    typeof tcaRaw === 'string' ? tcaRaw.trim().replace(' ', 'T') : tcaRaw;
  const tca =
    typeof tcaText === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/i.test(tcaText)
      ? Date.parse(`${tcaText}Z`)
      : Date.parse(tcaText);
  if (!Number.isFinite(tca)) return null;
  const primaryId = String(pick('SAT_1_ID', 'sat_1_id') ?? '').trim();
  const secondaryId = String(pick('SAT_2_ID', 'sat_2_id') ?? '').trim();
  if (!primaryId) return null;
  const minRange = Number(pick('MIN_RNG', 'min_rng', 'MISS_DISTANCE'));
  const pc = Number(pick('PC', 'pc'));
  const relativeSpeed = Number(pick('RELATIVE_SPEED', 'relative_speed'));
  return {
    id: String(
      pick('CDM_ID', 'cdm_id') ?? `${primaryId}:${secondaryId}:${tca}`,
    ),
    tca,
    primaryId,
    primaryName: String(
      pick('SAT_1_NAME', 'sat_1_name') || `NORAD ${primaryId}`,
    ),
    secondaryId,
    secondaryName: String(
      pick('SAT_2_NAME', 'sat_2_name') || `NORAD ${secondaryId}`,
    ),
    minRangeKm: Number.isFinite(minRange) ? minRange : null,
    pc: Number.isFinite(pc) ? pc : null,
    relativeSpeedKmS: Number.isFinite(relativeSpeed) ? relativeSpeed : null,
  };
}

/**
 * Where each conjunction's primary object is at its time of closest approach.
 * The public CDM carries relative RTN geometry, not a latitude and longitude,
 * so the point is the primary's sub-satellite point propagated from its own
 * element set at TCA. That is what the marker means, and the label says it.
 *
 * @param {Array<object>} messages Parsed CDM rows.
 * @param {Array<object>} gpEntries Space-Track element-set entries.
 * @param {number} [limit]
 */
export function conjunctionsFromCdm(messages, gpEntries, limit = 24) {
  const byNorad = new Map();
  for (const entry of gpEntries || []) {
    if (entry?.norad) byNorad.set(String(entry.norad), entry);
  }
  const events = [];
  for (const message of messages || []) {
    const entry = byNorad.get(String(message.primaryId));
    if (!entry?.line1 || !entry?.line2) continue;
    const position = positionAt(
      entry.line1,
      entry.line2,
      new Date(message.tca),
    );
    if (!position) continue;
    events.push({
      id: `cdm:${message.id}`,
      norad: String(message.primaryId),
      name: message.primaryName,
      secondaryNorad: String(message.secondaryId || ''),
      secondaryName: message.secondaryName,
      tca: message.tca,
      minRangeKm: message.minRangeKm,
      pc: message.pc,
      relativeSpeedKmS: message.relativeSpeedKmS,
      lat: position.lat,
      lon: position.lon,
      altitudeKm: position.altitudeKm,
      // Labels are chosen by how close the pass is expected to be, which is the
      // question a conjunction list answers; Pc breaks ties.
      priority: 1e6 - (message.minRangeKm ?? 1e6) * 1000 + (message.pc || 0),
    });
  }
  events.sort((a, b) => b.priority - a.priority);
  return events.slice(0, Math.max(0, Math.floor(limit) || 0));
}

/** Ambient label for one conjunction at its close approach. */
export function createConjunctionLabelEntry(
  event,
  position,
  translate = (t) => t,
) {
  const range = Number.isFinite(event.minRangeKm)
    ? `${event.minRangeKm.toFixed(2)} ${translate(msg('km'))}`
    : translate(msg('range unknown'));
  return {
    id: String(event.id),
    position,
    variant: 'label',
    title: `${event.name} × ${event.secondaryName}`,
    details: [`${translate(msg('TCA'))} ${range}`],
    accent: '#B794F4',
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

export function fromN2yoAbove(payload, cap) {
  const rows = Array.isArray(payload?.above) ? payload.above : [];
  const at = Number(payload?.at) || Date.now();
  const objects = [];
  for (const row of sampleEvenly(rows, cap)) {
    const lat = Number(row?.satlat);
    const lon = Number(row?.satlng);
    // The documented `above` answer names the altitude `satalt`; `alt` is kept
    // as a fallback for older mirrors of the same payload.
    const altitudeKm = Number(row?.satalt ?? row?.alt);
    if (![lat, lon, altitudeKm].every(Number.isFinite)) continue;
    objects.push(
      record('n2yo', row.satid, row.satname, { lat, lon, altitudeKm }, at),
    );
  }
  return objects;
}

/** N2YO answers 200 with an error body, so the body is what decides. */
export function parseN2yoPayload(payload) {
  if (payload?.error) {
    return { ok: false, error: String(payload.error), above: [] };
  }
  return {
    ok: true,
    error: null,
    above: Array.isArray(payload?.above) ? payload.above : [],
  };
}

/** Ambient label for one inferred manoeuvre. */
export function createWatchLabelEntry(event, position, translate = (t) => t) {
  return {
    id: String(event.id),
    position,
    variant: 'label',
    title: String(event.name),
    details: [`${translate('~')}${Math.round(event.deltaVMps)} m/s`],
    accent: '#F6AD55',
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

/** One line summarising what each switch currently holds. */
export function watchSummary(counts, total, label) {
  const on = WATCH_SOURCES.filter((source) => (counts[source.id] || 0) > 0);
  if (!on.length) return null;
  const parts = on.map((source) => `${source.label} ${counts[source.id] || 0}`);
  return `${label}: ${total} · ${parts.join(' · ')}`;
}
