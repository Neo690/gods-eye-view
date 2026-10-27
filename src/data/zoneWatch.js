/**
 * Zone watch — the edge detector behind the alert centre's zone rules.
 *
 * A rule (src/data/zoneRules.js) says which circle and which identifiers; this
 * module decides WHEN to report, because the operator cares about transitions
 * rather than states: an aircraft that has been inside the circle for an hour is
 * not news, but the moment it crossed the ring is. So the detector keeps one
 * membership record per (rule, contact) and reports only the edges.
 *
 * Four readings decide the behaviour, all of them deliberate:
 *  - a contact FIRST SEEN inside is an entry: the app never saw it outside, and
 *    a ship that appears already in the harbour is exactly what the rule is for;
 *  - a contact that goes silent is NOT an exit — an exit means it was seen
 *    outside the ring. Silence past `missingGraceMs` only drops the membership,
 *    so a contact that comes back is a new arrival rather than a resurrection;
 *  - parking needs a real dwell: inside and stationary continuously for
 *    `parkingDwellMs`, reported once per stay, and a contact with no speed
 *    reported can never be judged stationary;
 *  - an incident id carries the instant of its transition, so dismissing one
 *    hides that alert rather than muting the contact for the rest of the day.
 *
 * Pure and stateful: plain arrays in, plain objects out, no Cesium, no DOM, no
 * fetches. The alert centre polls it every scan; a test drives it directly.
 *
 * @module data/zoneWatch
 */

import { msg } from '../i18n/marker.js';
import { isGeoPoint } from '../geoDistance.js';
import { INCIDENT_SEVERITY } from './incidentScan.js';
import {
  ZONE_RULE_KINDS,
  ZONE_WATCH_KINDS,
  isWatched,
  normalizeWatchId,
  zoneContainsPoint,
} from './zoneRules.js';

/** The incident kinds this detector reports. */
export const ZONE_INCIDENT_KINDS = Object.freeze({
  entry: 'zone-entry',
  exit: 'zone-exit',
  parking: 'zone-parking',
});

/** Layer a contact of each channel reports under, when its record says nothing. */
const CHANNEL_LAYER = Object.freeze({
  aircraft: 'flights',
  vessel: 'ais-live-vessels',
});

/**
 * Detection thresholds, in one place so the panel's behaviour can be reasoned
 * about (and tested) without reading the rules below.
 */
export const ZONE_WATCH_LIMITS = Object.freeze({
  /** Ground speed (m/s) under which an aircraft counts as stationary (~6 kt). */
  aircraftStationaryMps: 3,
  /** Speed (kt) under which a vessel counts as stationary. */
  vesselStationaryKts: 1,
  /** Inside and stationary this long before a stay becomes a parking alert. */
  parkingDwellMs: 10 * 60 * 1000,
  /** How long a contact may go unreported before its membership is dropped. */
  missingGraceMs: 90 * 1000,
  /** Upper bound on tracked contacts per scan: the feeds cap their own lists. */
  maxContacts: 8000,
  /** Upper bound on incidents one scan may report. */
  maxIncidents: 40,
});

const text = (value) => {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
};

const numeric = (value) => (Number.isFinite(value) ? value : null);

/** `kind:id` for a contact, so the two channels cannot collide. */
const contactIdentity = (contact) =>
  `${contact.channel}:${contact.channel === 'vessel' ? contact.mmsi : contact.icao24}`;

/** One membership record per rule and contact, in the flat state map. */
const stateKey = (ruleId, contact) =>
  `${ruleId}\u0000${contactIdentity(contact)}`;

/**
 * Normalise one layer record as a contact the watch can judge.
 * @param {object} row
 * @param {'aircraft'|'vessel'} channel
 * @returns {object|null} null when the row has no usable identifier or position.
 */
export function toContact(row, channel) {
  if (channel === 'vessel') {
    const mmsi = normalizeWatchId(ZONE_WATCH_KINDS.mmsi, row?.mmsi);
    if (!mmsi || !isGeoPoint({ lat: row?.lat, lon: row?.lon })) return null;
    return {
      channel: 'vessel',
      mmsi,
      id: mmsi,
      label: text(row?.name) || mmsi,
      lat: Number(row.lat),
      lon: Number(row.lon),
      speedKts: numeric(row?.speedKts),
      stationarySpeed: 'vessel',
      layerId: text(row?.layerId) || CHANNEL_LAYER.vessel,
    };
  }
  const icao24 = normalizeWatchId(ZONE_WATCH_KINDS.icao24, row?.icao24);
  if (!icao24 || !isGeoPoint({ lat: row?.lat, lon: row?.lon })) return null;
  return {
    channel: 'aircraft',
    icao24,
    id: icao24,
    label: text(row?.callsign) || text(row?.registration) || icao24,
    lat: Number(row.lat),
    lon: Number(row.lon),
    speedMps: numeric(row?.speedMps),
    onGround: row?.onGround === true,
    stationarySpeed: 'aircraft',
    layerId:
      text(row?.layerId) ||
      (row?.military === true ? 'military' : CHANNEL_LAYER.aircraft),
  };
}

/**
 * Every contact a snapshot holds, deduplicated by identity and bounded.
 *
 * @param {object} [source]
 * @param {Array<object>} [source.flights]     aircraft analyst records
 * @param {Array<object>} [source.military]    military analyst records
 * @param {Array<object>} [source.vessels]     AIS analyst records
 * @param {object} [options]
 * @param {number} [options.maxContacts]
 * @returns {Array<object>} Contacts, in source order.
 */
export function collectZoneContacts(
  source = {},
  { maxContacts = ZONE_WATCH_LIMITS.maxContacts } = {},
) {
  const contacts = [];
  const seen = new Set();
  const add = (rows, channel) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (contacts.length >= maxContacts) return;
      const contact = toContact(row, channel);
      if (!contact) continue;
      const identity = contactIdentity(contact);
      if (seen.has(identity)) continue;
      seen.add(identity);
      contacts.push(contact);
    }
  };
  add(source.flights, 'aircraft');
  add(source.military, 'aircraft');
  add(source.vessels, 'vessel');
  return contacts;
}

/**
 * Whether a contact is stationary, and whether that could be judged at all: a
 * position with no speed is not evidence of parking.
 * @param {object} contact
 * @param {object} limits
 * @returns {boolean}
 */
export function isStationary(contact, limits = ZONE_WATCH_LIMITS) {
  if (contact?.stationarySpeed === 'vessel') {
    if (contact.speedKts === null) return false;
    return contact.speedKts < limits.vesselStationaryKts;
  }
  if (contact?.onGround === true) return true;
  if (contact?.speedMps === null) return false;
  return contact.speedMps < limits.aircraftStationaryMps;
}

/**
 * The zone watch: keeps the membership of every (rule, contact) pair and
 * reports the transitions it sees between two snapshots.
 */
export class ZoneWatch {
  /**
   * @param {{now?: () => number, limits?: object}} [options]
   */
  constructor({ now = () => Date.now(), limits = ZONE_WATCH_LIMITS } = {}) {
    this._now = now;
    this._limits = limits;
    /** @type {Map<string, object>} ruleId+contact → membership */
    this._entries = new Map();
  }

  /** How many membership records are being kept, for the panel and tests. */
  get size() {
    return this._entries.size;
  }

  /**
   * Compare a snapshot with the previous one and return this scan's incidents.
   *
   * @param {object} source                The analyst records to judge.
   * @param {Array<object>} rules          The stored rules (see zoneRules.js).
   * @param {number} [at]
   * @returns {Array<object>} Incidents in the alert centre's shape, in rule
   *   order, at most `maxIncidents`.
   */
  update(source, rules = [], at = this._now()) {
    const limits = this._limits;
    const contacts = collectZoneContacts(source, {
      maxContacts: limits.maxContacts,
    });
    const present = new Set();
    const incidents = [];
    const active = (Array.isArray(rules) ? rules : []).filter(
      (rule) => rule?.enabled !== false,
    );

    for (const rule of active) {
      for (const contact of contacts) {
        const key = stateKey(rule.id, contact);
        present.add(key);
        const entry = this._entries.get(key) ?? {
          inside: false,
          stillSinceMs: null,
          parked: false,
          missingAtMs: null,
        };
        entry.missingAtMs = null;
        const inside = zoneContainsPoint(rule, contact);

        if (!inside) {
          // Seen OUTSIDE the ring: that, and only that, is what an exit means.
          if (entry.inside && rule.kind === ZONE_RULE_KINDS.exit) {
            incidents.push(this._incident(rule, contact, 'exit', at));
          }
          entry.inside = false;
          entry.stillSinceMs = null;
          entry.parked = false;
        } else {
          if (!entry.inside && rule.kind === ZONE_RULE_KINDS.entry) {
            incidents.push(this._incident(rule, contact, 'entry', at));
          }
          entry.inside = true;
          const stationary = isStationary(contact, limits);
          if (stationary) {
            if (entry.stillSinceMs === null) entry.stillSinceMs = at;
            const dwell = at - entry.stillSinceMs;
            if (
              !entry.parked &&
              dwell >= limits.parkingDwellMs &&
              rule.kind === ZONE_RULE_KINDS.parking
            ) {
              entry.parked = true;
              incidents.push(
                this._incident(rule, contact, 'parking', at, {
                  minutes: Math.round(dwell / 60000),
                }),
              );
            }
          } else {
            entry.stillSinceMs = null;
            entry.parked = false;
          }
        }
        this._entries.set(key, entry);
      }
    }
    this._dropMissing(present, at);
    return incidents.slice(0, limits.maxIncidents);
  }

  /**
   * Forget contacts the snapshot no longer reports, once the grace period has
   * passed. Nothing is emitted: silence is not an exit.
   * @param {Set<string>} present
   * @param {number} at
   */
  _dropMissing(present, at) {
    for (const [key, entry] of this._entries) {
      if (present.has(key)) continue;
      entry.missingAtMs ??= at;
      if (at - entry.missingAtMs > this._limits.missingGraceMs)
        this._entries.delete(key);
    }
  }

  /**
   * One incident, in the shape the alert centre renders: English template keys
   * and params, resolved by `localizeIncident`.
   * @param {object} rule
   * @param {object} contact
   * @param {'entry'|'exit'|'parking'} event
   * @param {number} at
   * @param {{minutes?: number}} [extra]
   * @returns {object}
   */
  _incident(rule, contact, event, at, extra = {}) {
    const channel = contact.channel === 'vessel' ? 'mmsi' : 'icao24';
    const watched = isWatched(rule, channel, contact.id);
    const params = {
      contact: contact.label,
      zone: rule.name,
      identifier: contact.id,
    };
    const title =
      event === 'parking'
        ? {
            key: msg('Parked in {zone} — {contact}'),
            params,
          }
        : {
            key:
              event === 'entry'
                ? msg('Zone entry — {contact}')
                : msg('Zone exit — {contact}'),
            params,
          };
    const detail =
      event === 'parking'
        ? {
            key: msg('Stationary {minutes} min · {identifier}'),
            params: { ...params, minutes: extra.minutes ?? 0 },
          }
        : {
            key:
              event === 'entry'
                ? msg('Entered {zone} · {identifier}')
                : msg('Left {zone} · {identifier}'),
            params,
          };
    return {
      // The instant is part of the id on purpose: see the module note.
      id: `zone:${rule.id}:${event}:${contactIdentity(contact)}:${at}`,
      kind: ZONE_INCIDENT_KINDS[event],
      // A listed identifier is what the operator singled out; the rest of a
      // zone's traffic stays a warning.
      severity: watched
        ? INCIDENT_SEVERITY.critical
        : INCIDENT_SEVERITY.warning,
      layerId: contact.layerId,
      lat: contact.lat,
      lon: contact.lon,
      atMs: at,
      title,
      detail,
    };
  }
}
