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
import { formatEpoch, parseTleCatalog } from '../orbitChanges/model.js';

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

/**
 * One element set's velocity vector at `date`, km/s in the frame SGP4 answers in.
 * @param {string} line1
 * @param {string} line2
 * @param {Date} date
 * @returns {{x:number, y:number, z:number}|null}
 */
function velocityAt(line1, line2, date) {
  try {
    const satrec = twoline2satrec(line1, line2);
    if (!satrec || satrec.error) return null;
    const state = propagate(satrec, date);
    const velocity = state?.velocity;
    if (!velocity) return null;
    const { x, y, z } = velocity;
    if (![x, y, z].every(Number.isFinite)) return null;
    return { x, y, z };
  } catch {
    return null;
  }
}

/**
 * How fast two objects close on each other at one instant, in km/s.
 *
 * The public CDM feed does not publish `RELATIVE_SPEED` — measured on the live
 * feed, none of its sixty rows carried the field — so the number the card shows
 * has to come from the two element sets this layer already reads. Both vectors
 * are taken at the same instant, the time of closest approach, which is the
 * only pair of instants the two objects are known to be at the same place.
 *
 * This is a propagation, not a measurement: it inherits the element sets' own
 * error (kilometres along-track for a days-old TLE), and it is only the closing
 * rate at TCA, not the speed at any other moment.
 *
 * @param {string} line1A Primary's line 1
 * @param {string} line2A Primary's line 2
 * @param {string} line1B Secondary's line 1
 * @param {string} line2B Secondary's line 2
 * @param {Date} date
 * @returns {number|null} km/s, or null when either set cannot be propagated.
 */
export function relativeSpeedAt(line1A, line2A, line1B, line2B, date) {
  const first = velocityAt(line1A, line2A, date);
  const second = velocityAt(line1B, line2B, date);
  if (!first || !second) return null;
  const speed = Math.hypot(
    first.x - second.x,
    first.y - second.y,
    first.z - second.z,
  );
  return Number.isFinite(speed) ? speed : null;
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
 * A CDM number, or null when the row carries none.
 *
 * `Number(null)` is 0, and the public feed omits `RELATIVE_SPEED` on every row,
 * so reading the fields with a bare `Number()` turns "absent" into "zero km/s"
 * and "Pc 0" — both of which are measurements, and wrong ones. The field's
 * absence is therefore kept as an absence.
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * One public CDM row, normalised. Space-Track returns upper-case keys in the
 * documented JSON; lower-case variants are accepted so a format change costs a
 * field, not the layer.
 *
 * A field the feed omits stays `null`: the public feed publishes no
 * `RELATIVE_SPEED`, and `Number(null)` would report that absence as 0 km/s.
 * @returns {{id:string, tca:number, primaryId:string, primaryName:string,
 *   secondaryId:string, secondaryName:string, minRangeKm:number|null,
 *   pc:number|null, relativeSpeedKmS:number|null}|null}
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
  const minRange = finiteOrNull(pick('MIN_RNG', 'min_rng', 'MISS_DISTANCE'));
  const pc = finiteOrNull(pick('PC', 'pc'));
  const relativeSpeed = finiteOrNull(pick('RELATIVE_SPEED', 'relative_speed'));
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
    minRangeKm: minRange,
    pc,
    relativeSpeedKmS: relativeSpeed,
  };
}

/**
 * A catalogue number as an identity, not as text.
 *
 * Space-Track's GP element lines carry the number zero-padded to five digits
 * (`"06121"`) while the CDM's `SAT_1_ID` is the bare number (`"6121"`), so a
 * plain string lookup silently finds nothing for every object below 10 000.
 * Measured on the live feed: 0 of 60 conjunctions matched before this, 7 after.
 * @param {unknown} value
 * @returns {string}
 */
export function noradKey(value) {
  const text = String(value ?? '').trim();
  return text.replace(/^0+(?=\d)/, '');
}

/**
 * The element sets a closing rate needs that the read did not carry.
 *
 * The GP window is a sample of the catalogue (1 200 of ~30 000 objects) and the
 * public conjunction feed pairs crewed/active primaries with debris, so on the
 * live feed **none** of the secondaries is in it. These numbers are fetched
 * individually to complete the pair; an event whose primary is itself unknown
 * is skipped, since it cannot be placed anyway.
 *
 * @param {Array<{norad?:string}>} entries
 * @param {Array<object>} messages `parseCdmMessage` output
 * @param {number} [limit]
 * @returns {string[]}
 */
export function missingSecondaryNorads(entries, messages, limit = 12) {
  const cap = Math.max(0, Math.floor(limit) || 0);
  if (!cap) return [];
  const known = new Set((entries || []).map((entry) => noradKey(entry?.norad)));
  const wanted = [];
  for (const message of messages || []) {
    if (Number.isFinite(message?.relativeSpeedKmS)) continue;
    if (!known.has(noradKey(message?.primaryId))) continue;
    const key = noradKey(message?.secondaryId);
    if (!key || known.has(key) || wanted.includes(key)) continue;
    wanted.push(key);
    if (wanted.length >= cap) break;
  }
  return wanted;
}

/**
 * Where each conjunction's primary object is at its time of closest approach.
 * The public CDM carries relative RTN geometry, not a latitude and longitude,
 * so the point is the primary's sub-satellite point propagated from its own
 * element set at TCA. That is what the marker means, and the label says it.
 *
 * The closing rate comes from the CDM when the feed publishes one, otherwise
 * from propagating both element sets to TCA; `relativeSpeedSource` says which.
 * @param {Array<object>} messages Parsed CDM rows.
 * @param {Array<object>} gpEntries Space-Track element-set entries.
 * @param {number} [limit]
 */
export function conjunctionsFromCdm(messages, gpEntries, limit = 24) {
  const byNorad = new Map();
  for (const entry of gpEntries || []) {
    if (entry?.norad) byNorad.set(noradKey(entry.norad), entry);
  }
  const events = [];
  for (const message of messages || []) {
    const entry = byNorad.get(noradKey(message.primaryId));
    if (!entry?.line1 || !entry?.line2) continue;
    const at = new Date(message.tca);
    const position = positionAt(entry.line1, entry.line2, at);
    if (!position) continue;
    // The feed's own number wins when it has one: it is the operator's figure
    // for this event. Only when the field is absent — which, on the public
    // feed, is always — is the closing rate propagated from both element sets.
    const secondary = message.secondaryId
      ? byNorad.get(noradKey(message.secondaryId))
      : null;
    let relativeSpeedKmS = message.relativeSpeedKmS;
    let relativeSpeedSource = Number.isFinite(relativeSpeedKmS) ? 'cdm' : null;
    if (!relativeSpeedSource && secondary?.line1 && secondary?.line2) {
      relativeSpeedKmS = relativeSpeedAt(
        entry.line1,
        entry.line2,
        secondary.line1,
        secondary.line2,
        at,
      );
      relativeSpeedSource = Number.isFinite(relativeSpeedKmS)
        ? 'elements'
        : null;
    }
    events.push({
      id: `cdm:${message.id}`,
      // The catalogue's own spelling of the number, so an event carries the
      // same identity as its element set ("06121", not the CDM's "6121").
      norad: String(entry.norad || message.primaryId),
      name: message.primaryName,
      secondaryNorad: String(secondary?.norad || message.secondaryId || ''),
      secondaryName: message.secondaryName,
      tca: message.tca,
      minRangeKm: message.minRangeKm,
      pc: message.pc,
      relativeSpeedKmS,
      relativeSpeedSource,
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

/**
 * A collision probability in the form the feed reports it: these are
 * probabilities of order 1e-5 to 1e-3, and a fixed-point "0.000" would say
 * "impossible" for every one of them.
 * @param {unknown} value Raw Pc.
 * @returns {string} Exponent form, or '' when the feed gave no number.
 */
export function formatCollisionProbability(value) {
  const pc = Number(value);
  if (value === null || value === undefined || value === '') return '';
  if (!Number.isFinite(pc)) return '';
  if (pc === 0) return '0';
  return pc.toExponential(2);
}

/**
 * Everything one conjunction knows, in the lines a click reveals.
 *
 * The ambient label carries the one number a glance needs (the expected miss);
 * this card carries what a decision needs: both objects by name and catalog
 * number, the probability of collision, the time of closest approach, the
 * relative speed, and which feed said so. A value the CDM omitted reads
 * "Unavailable" rather than a zero, because a zero Pc is a measurement.
 *
 * @param {object} event One entry from {@link conjunctionsFromCdm}.
 * @param {*} position Cartesian3 of the marker.
 * @param {(text: string) => string} [translate]
 */
export function createConjunctionDetailEntry(
  event,
  position,
  translate = (t) => t,
) {
  const secondary = event.secondaryNorad ? ` × ${event.secondaryNorad}` : '';
  const pc = formatCollisionProbability(event.pc);
  // `Number(null)` is 0: an omitted speed would otherwise print "0.00 km/s",
  // which claims the two objects are not moving relative to each other.
  const rawSpeed = event.relativeSpeedKmS;
  const speed =
    rawSpeed === null || rawSpeed === undefined || rawSpeed === ''
      ? Number.NaN
      : Number(rawSpeed);
  return {
    id: String(event.id),
    position,
    variant: 'label',
    title: `${event.name} × ${event.secondaryName}`,
    details: [
      `${translate(msg('NORAD'))} ${event.norad}${secondary}`,
      `${translate(msg('Pc'))} ${pc || translate(msg('Unavailable'))}`,
      `${translate(msg('TCA'))} ${formatEpoch(Number(event.tca))}`,
      `${translate(msg('Relative speed'))} ${
        Number.isFinite(speed)
          ? `${speed.toFixed(2)} ${translate(msg('km'))}/s`
          : translate(msg('Unavailable'))
      }${
        // A propagated number is marked as one: the feed did not say this.
        event.relativeSpeedSource === 'elements'
          ? ` (${translate(msg('computed'))})`
          : ''
      }`,
      `${translate(msg('Source'))} ${translate(msg('Space-Track CDM'))}`,
    ],
    accent: '#B794F4',
    priority: event.priority,
    collisionGroup: 'conjunction-detail',
    paintLane: 'ambient-label',
    // The host draws a selected card with the wider frame and the brighter
    // border, which is what makes the clicked conjunction read as opened.
    selected: true,
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
