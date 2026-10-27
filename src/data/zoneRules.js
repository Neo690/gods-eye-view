/**
 * Zone rules — the model behind the alert centre's entry/exit/parking watch.
 *
 * A rule is a circle on the ground plus the identifiers the operator cares
 * about. It says WHAT to watch; the edge detector (src/data/zoneWatch.js) owns
 * WHEN to report, because an entry is a transition rather than a state, and the
 * alert centre (src/ui/alertCenter.js) owns the panel and the storage.
 *
 * Pure and portable: plain objects in, plain objects out, no Cesium, no DOM, no
 * fetches. Storage is passed in as the `Storage`-shaped object it happens to be,
 * so a test drives the real code with a fake.
 *
 * Two deliberate readings, because they decide who gets alerted:
 *  - an EMPTY watch list means every contact — a rule is a zone first and a
 *    watch list second, so "tell me when anything enters the marina" needs no
 *    identifiers at all;
 *  - a listed identifier is what the operator singled out, so the watcher
 *    reports those as critical and everything else as a warning.
 *
 * @module data/zoneRules
 */

import { msg } from '../i18n/marker.js';
import { greatCircleKm, isGeoPoint } from '../geoDistance.js';

/** The three things a zone can be watched for. */
export const ZONE_RULE_KINDS = Object.freeze({
  entry: 'entry',
  exit: 'exit',
  parking: 'parking',
});

/** Which identifiers a rule may list, and the field that holds each. */
export const ZONE_WATCH_KINDS = Object.freeze({
  icao24: 'icao24',
  mmsi: 'mmsi',
});

/**
 * Rule bounds, in one place so the panel can state them and the tests can
 * reason about them without reading the parsers.
 */
export const ZONE_RULE_LIMITS = Object.freeze({
  /** Upper bound on stored rules: the panel and the scan stay small. */
  maxRules: 24,
  /** Upper bound per watch list, per rule. */
  maxWatchIds: 50,
  /** A name is a label, not a document. */
  maxNameLength: 60,
  /** Below this a circle is smaller than the position jitter of the feeds. */
  minRadiusKm: 0.25,
  /** Above this the "zone" is a whole region and the alerts are noise. */
  maxRadiusKm: 500,
  /** What the panel offers when the radius field is empty. */
  defaultRadiusKm: 5,
});

/** Where the rules live between sessions, beside the dismissals. */
export const ZONE_RULES_STORAGE_KEY = 'gev.zones.rules';

const ICAO24 = /^[0-9A-F]{6}$/;
const MMSI = /^[0-9]{9}$/;

const text = (value) =>
  typeof value === 'string'
    ? value.trim()
    : value == null
      ? ''
      : String(value).trim();

/**
 * A 24-bit ICAO address as the feeds report it: six hex digits, case-folded so
 * `3C4B26` and `3c4b26` are the same aircraft.
 * @param {unknown} value
 * @returns {string|null} The normalised address, or null when it is not one.
 */
export function normalizeIcao24(value) {
  const address = text(value).toUpperCase().replace(/^0X/, '');
  return ICAO24.test(address) ? address : null;
}

/**
 * A nine-digit MMSI, as the AIS feeds report it.
 * @param {unknown} value
 * @returns {string|null} The normalised MMSI, or null when it is not one.
 */
export function normalizeMmsi(value) {
  const digits = text(value).replace(/[\s-]/g, '');
  return MMSI.test(digits) ? digits : null;
}

/**
 * Normalise one identifier for its channel.
 * @param {'icao24'|'mmsi'} kind
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeWatchId(kind, value) {
  return kind === ZONE_WATCH_KINDS.mmsi
    ? normalizeMmsi(value)
    : normalizeIcao24(value);
}

/**
 * Read what the operator typed into a watch-list field: identifiers separated
 * by commas, spaces or newlines. Nothing is silently dropped — what does not
 * look like an identifier comes back in `rejected` so the panel can say so,
 * and `seen` keeps the order the identifiers were typed in.
 *
 * @param {string} source
 * @param {'icao24'|'mmsi'} kind
 * @returns {{ids: string[], rejected: string[]}}
 */
export function parseWatchList(source, kind) {
  const ids = [];
  const rejected = [];
  const seen = new Set();
  for (const token of text(source).split(/[\s,;]+/)) {
    if (!token) continue;
    const id = normalizeWatchId(kind, token);
    if (!id) {
      rejected.push(token);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    if (ids.length < ZONE_RULE_LIMITS.maxWatchIds) ids.push(id);
  }
  return { ids, rejected };
}

/**
 * Split one field of typed identifiers into the two channels a rule keeps.
 *
 * Six hex digits and nine digits cannot be confused, so the panel needs a
 * single field rather than two: whatever does not look like either comes back
 * in `rejected` for the operator to correct.
 *
 * @param {string} source
 * @returns {{icao24: string[], mmsi: string[], rejected: string[]}}
 */
export function parseWatchIdentifiers(source) {
  const icao24 = [];
  const mmsi = [];
  const rejected = [];
  const seen = new Set();
  for (const token of text(source).split(/[\s,;]+/)) {
    if (!token) continue;
    const address = normalizeIcao24(token);
    const digits = address ? null : normalizeMmsi(token);
    const id = address || digits;
    if (!id) {
      rejected.push(token);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const channel = address ? icao24 : mmsi;
    if (channel.length < ZONE_RULE_LIMITS.maxWatchIds) channel.push(id);
  }
  return { icao24, mmsi, rejected };
}

/**
 * One watch channel's identifiers, from what the panel holds: the typed text,
 * or the lists it already split.
 * @param {'icao24'|'mmsi'} kind
 * @param {unknown} value
 * @returns {string[]}
 */
function watchChannel(kind, value) {
  if (Array.isArray(value)) {
    const seen = new Set();
    for (const entry of value) {
      const id = normalizeWatchId(kind, entry);
      if (id) seen.add(id);
    }
    return [...seen].slice(0, ZONE_RULE_LIMITS.maxWatchIds);
  }
  return parseWatchList(text(value), kind).ids;
}

/** The watch list a rule holds for one channel, ready to compare. */
function watchIds(rule, kind) {
  const list = rule?.watch?.[kind];
  return Array.isArray(list) ? list : [];
}

/**
 * Whether a rule has singled an identifier out.
 * @param {object} rule
 * @param {'icao24'|'mmsi'} kind
 * @param {unknown} id
 * @returns {boolean}
 */
export function isWatched(rule, kind, id) {
  const list = watchIds(rule, kind);
  if (!list.length) return false;
  const wanted = normalizeWatchId(kind, id);
  return wanted ? list.includes(wanted) : false;
}

/**
 * Whether a rule watches every contact rather than a list.
 * @param {object} rule
 * @returns {boolean}
 */
export function watchesEverything(rule) {
  return (
    !watchIds(rule, ZONE_WATCH_KINDS.icao24).length &&
    !watchIds(rule, ZONE_WATCH_KINDS.mmsi).length
  );
}

/**
 * Distance from a rule's centre to a point, in km.
 * @param {object} rule
 * @param {{lat: number, lon: number}} point
 * @returns {number|null} null when either the rule or the point is unusable.
 */
export function zoneDistanceKm(rule, point) {
  const centre = { lat: rule?.centre?.lat, lon: rule?.centre?.lon };
  if (!isGeoPoint(centre) || !isGeoPoint(point)) return null;
  return greatCircleKm(centre, point);
}

/**
 * Whether a point is inside a rule's circle. The ring itself counts as inside,
 * so a contact sitting exactly on the radius does not flicker between scans.
 * @param {object} rule
 * @param {{lat: number, lon: number}} point
 * @returns {boolean}
 */
export function zoneContainsPoint(rule, point) {
  const distance = zoneDistanceKm(rule, point);
  if (distance === null) return false;
  const radius = Number(rule?.radiusKm);
  if (!Number.isFinite(radius) || radius <= 0) return false;
  return distance <= radius;
}

/**
 * A fresh rule id, unique among `existing`. Derived from the largest suffix in
 * use rather than from randomness, so a test can predict it and a reload keeps
 * ids stable.
 * @param {Array<object>} existing
 * @returns {string}
 */
export function nextZoneRuleId(existing = []) {
  let highest = 0;
  for (const rule of existing) {
    const match = /^zone-(\d+)$/.exec(text(rule?.id));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `zone-${highest + 1}`;
}

/**
 * One rule's worth of the operator's input, checked and normalised.
 *
 * @param {object} input
 * @param {string} [input.name]
 * @param {'entry'|'exit'|'parking'} [input.kind]
 * @param {{lat: unknown, lon: unknown}} [input.centre]
 * @param {unknown} [input.radiusKm]
 * @param {{icao24?: string|string[], mmsi?: string|string[]}} [input.watch]
 *   Typed text or the lists the panel already split.
 * @param {boolean} [input.enabled]
 * @param {string} [id]          Kept for an existing rule, generated otherwise.
 * @param {Array<object>} [existing] Needed only to generate a unique id.
 * @returns {{ok: true, rule: object}|{ok: false, reason: string}}
 *   `reason` is a message key the panel can translate.
 */
export function validateZoneRule(input, { id, existing = [] } = {}) {
  // Stored rules are untrusted input: a null entry must be refused, not throw.
  const source = input ?? {};
  const kind = text(source.kind);
  if (!Object.hasOwn(ZONE_RULE_KINDS, kind)) {
    return { ok: false, reason: msg('Pick what the zone should watch for') };
  }
  const name = text(source.name).slice(0, ZONE_RULE_LIMITS.maxNameLength);
  if (!name) return { ok: false, reason: msg('Name the zone') };
  const centre = {
    lat: Number(source.centre?.lat),
    lon: Number(source.centre?.lon),
  };
  if (!isGeoPoint(centre)) {
    return { ok: false, reason: msg('The zone needs a position on the map') };
  }
  const radiusKm = Number(source.radiusKm);
  if (
    !Number.isFinite(radiusKm) ||
    radiusKm < ZONE_RULE_LIMITS.minRadiusKm ||
    radiusKm > ZONE_RULE_LIMITS.maxRadiusKm
  ) {
    return {
      ok: false,
      reason: msg('The radius must be between {min} and {max} km'),
    };
  }
  return {
    ok: true,
    rule: Object.freeze({
      id: text(id) || nextZoneRuleId(existing),
      name,
      kind,
      centre,
      radiusKm,
      watch: Object.freeze({
        icao24: watchChannel(ZONE_WATCH_KINDS.icao24, source.watch?.icao24),
        mmsi: watchChannel(ZONE_WATCH_KINDS.mmsi, source.watch?.mmsi),
      }),
      enabled: source.enabled !== false,
    }),
  };
}

/**
 * Rules read back from storage, with anything unusable dropped rather than
 * thrown: a hand-edited or older entry must not stop the console from booting.
 *
 * @param {unknown} parsed
 * @returns {Array<object>}
 */
export function normalizeStoredRules(parsed) {
  if (!Array.isArray(parsed)) return [];
  const rules = [];
  for (const entry of parsed) {
    const result = validateZoneRule(entry, { id: entry?.id, existing: rules });
    if (result.ok) rules.push(result.rule);
    if (rules.length >= ZONE_RULE_LIMITS.maxRules) break;
  }
  return rules;
}

/**
 * The stored rules, or none when storage is empty, unreadable or holds
 * something else.
 * @param {Storage} [storage]
 * @returns {Array<object>}
 */
export function readStoredRules(storage) {
  try {
    const raw = storage?.getItem(ZONE_RULES_STORAGE_KEY);
    if (!raw) return [];
    return normalizeStoredRules(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Persist the rules. A storage refusal (private mode, quota) leaves the
 * session working: the rules live in memory and only the reload loses them.
 * @param {Storage} [storage]
 * @param {Array<object>} rules
 * @returns {boolean} Whether the write was accepted.
 */
export function writeStoredRules(storage, rules) {
  if (!storage) return false;
  try {
    storage.setItem(ZONE_RULES_STORAGE_KEY, JSON.stringify(rules));
    return true;
  } catch {
    return false;
  }
}

/**
 * How many identifiers a rule lists, both channels together.
 * @param {object} rule
 * @returns {number}
 */
export function watchCount(rule) {
  return (
    watchIds(rule, ZONE_WATCH_KINDS.icao24).length +
    watchIds(rule, ZONE_WATCH_KINDS.mmsi).length
  );
}
