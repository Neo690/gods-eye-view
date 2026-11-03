import { readResponse, LiveSourceError } from './contract.js';
import { vesselSnapshot } from './vessels.js';

const defaultFetch = (...args) => globalThis.fetch(...args);

// i18n-ignore: feed source name, reported verbatim to AI tools
export const AISCAST_FEED_LABEL = 'Aiscast';
/** The server route the extra source asks for. */
export const AISCAST_ROUTE_DEFAULT = '/api/vessels/aiscast';
/** Cover text, echoed by the connect page and reader tooling. */
export const AISCAST_COVERAGE =
  "positions received by the operator's own aiscast ingester (Open Waters AIS)";

function emptySnapshot(status) {
  return {
    records: [],
    source: AISCAST_FEED_LABEL,
    coverage: AISCAST_COVERAGE,
    complete: true,
    rejectedCount: 0,
    observedAtMs: null,
    freshness: 'unknown',
    stale: true,
    transportStatus: status,
    lastMessageAt: null,
    nextAttemptAt: null,
    silentForMs: null,
    reconnectAttempt: null,
    rawRowCount: 0,
  };
}

/**
 * The extra keyless vessel source: the server's `/api/vessels/aiscast` route
 * (the operator's own aiscast render of their own ingester). When the server
 * reports the route as not configured, or the route itself does not exist
 * (404), the source stores `state='absent'` and stops issuing requests so the
 * opt-in extra never hammers the primary feed path. It is resumed by the
 * source instance being recreated (a page reload or the layer re-wiring).
 * No request starts during construction.
 *
 * The extra source catches transport and shape errors itself and reports
 * them truthfully through transportStatus: it is a courtesy layer, never a
 * blocker for the resident feed, so the primary snapshot always flows.
 */
export function createAiscastVesselSource({
  fetchImpl = defaultFetch,
  url = AISCAST_ROUTE_DEFAULT,
} = {}) {
  // 'unknown' → one request decides 'active' or 'absent'.
  let state = 'unknown';
  return {
    // i18n-ignore: feed source name, replaced by the provider from each snapshot and reported to AI tools
    label: 'Aiscast',
    /** 'unknown' | 'active' | 'absent'; the compose reads it before fetching. */
    get state() {
      return state;
    },
    async getSnapshot(_query = {}, { signal } = {}) {
      if (state === 'absent') return emptySnapshot('absent');
      const { response, payload } = await readResponse(
        fetchImpl,
        url,
        { signal, cache: 'no-store' },
        AISCAST_FEED_LABEL,
      );
      if (!response.ok) {
        // Any failure shape is the same honest absence: the layer's own
        // status card names the primary feed, not this courtesy source, so
        // losing the extra source must never look like losing the feed.
        state = 'absent';
        return emptySnapshot('unavailable');
      }
      const configured = payload?.configured === true;
      if (!configured) {
        state = 'absent';
        return emptySnapshot('absent');
      }
      // Shape errors stay inside the snapshot: vesselSnapshot admits what it
      // can and rejects the rest with a count.
      state = 'active';
      return {
        ...vesselSnapshot(payload, {
          source:
            typeof payload?.source === 'string' && payload.source.trim()
              ? payload.source.trim()
              : AISCAST_FEED_LABEL,
          coverage: AISCAST_COVERAGE,
          referenceFor: (row) => String(row?.mmsi ?? ''),
        }),
        configured: true,
      };
    },
  };
}

/**
 * Merge an extra vessel snapshot into the primary one. Once a vessel is
 * served by both, the record with the newest explicit observed time wins;
 * when neither carries a time the primary record is kept, so the resident
 * AISStream feed continues to look like the truth it is. The each-record
 * `sources` array names every feed that contributed a vessel shown now.
 * Snapshot-accounting fields stay the primary's so acceptance/partial
 * retention semantics stay resident-feed-shaped.
 */
export function mergeVesselSnapshots(primary, extra) {
  if (!extra?.records?.length) return primary;
  const primaryLabel = String(primary?.source ?? primary?.label ?? 'Vessels');
  const extraLabel = String(extra.source ?? AISCAST_FEED_LABEL);
  if (extraLabel === primaryLabel) return primary;
  const records = [...primary.records];
  const indexById = new Map();
  for (let index = 0; index < records.length; index += 1)
    if (!indexById.has(records[index].id))
      indexById.set(records[index].id, index);
  for (const candidate of extra.records) {
    if (candidate?.id == null) continue;
    const index = indexById.get(candidate.id);
    if (index === undefined) {
      indexById.set(candidate.id, records.length);
      records.push({ ...candidate, sources: [extraLabel] });
      continue;
    }
    const existing = records[index];
    const winner =
      (candidate.observedAtMs ?? -Infinity) >
      (existing.observedAtMs ?? -Infinity)
        ? candidate
        : existing;
    records[index] = { ...winner, sources: [primaryLabel, extraLabel] };
  }
  const observedAtMs = [primary.observedAtMs, extra.observedAtMs]
    .filter((ms) => Number.isFinite(ms))
    .reduce((best, ms) => (best == null || ms > best ? ms : best), null);
  return {
    ...primary,
    records,
    source: `${primaryLabel} + ${extraLabel}`,
    observedAtMs: observedAtMs ?? primary.observedAtMs,
  };
}

/**
 * Wrap the primary vessel source so a healthy secondary (the operator's own
 * aiscast feed, when configured) adds vessels the resident AISStream feed
 * never carries: positions within `radius_km` of an area-aware query may
 * still include home-harbour traffic the public feed does not show.
 * The primary path answers exactly as before when the extra source is
 * absent, and when the primary fails and the extra has usable records the
 * extra keeps a picture on the map instead of an outage.
 */
export function composeVesselSources({ primary, extra } = {}) {
  if (!primary || typeof primary.getSnapshot !== 'function')
    throw new TypeError('composeVesselSources needs a primary vessel source');
  return {
    // i18n-ignore: feed source name, re-resolved from the primary's snapshot label
    label: primary.label ?? 'Vessels',
    async getSnapshot(query = {}, options = {}) {
      let primarySnapshot = null;
      let primaryError = null;
      try {
        primarySnapshot = await primary.getSnapshot(query, options);
      } catch (error) {
        primaryError = error;
      }
      let extraSnapshot = null;
      // The extra source manages its own opt-in state; the compose never
      // fetches on its behalf so a not-configured server stays one-request.
      if (extra && extra.state !== 'absent') {
        try {
          extraSnapshot = await extra.getSnapshot(query, options);
        } catch {
          extraSnapshot = null;
        }
      }
      if (primaryError) {
        const usable =
          extraSnapshot && extraSnapshot.records.length ? extraSnapshot : null;
        if (usable)
          return {
            ...usable,
            coverage: `${usable.coverage} — primary AIS feed unavailable (${primaryError.message})`,
            primaryError,
          };
        throw primaryError;
      }
      return mergeVesselSnapshots(primarySnapshot, extraSnapshot);
    },
    async getTrack(reference, options = {}) {
      return primary.getTrack(reference, options);
    },
  };
}

export { LiveSourceError };
