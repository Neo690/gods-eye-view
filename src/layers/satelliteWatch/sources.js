/**
 * Network readers for the satellite-watch sources.
 *
 * CelesTrak goes through the app's own cached route (the same one the
 * Satellites layer uses); the keyless TLE catalogue is also read through a
 * cached route, because one page takes 5–30 s upstream. N2YO is proxied too,
 * so its account key stays on the server; it answers its refusals in the body,
 * not in the status.
 *
 * @module layers/satelliteWatch/sources
 */
import { parseTleCatalog } from '../orbitChanges/model.js';
import {
  WATCH_CATALOG_GROUPS,
  WATCH_TLE_API_PAGES,
  parseN2yoPayload,
} from './model.js';

// The catalogue is read through the app's own cached route: the upstream
// answers in 5–30 s a page (24–30 s TTFB when measured), so the browser never
// talks to it directly.
const TLE_API = '/api/tle-catalogue/';

/** The generation each proxy cache replaced, kept for a first comparison. */
const PREVIOUS_TLE_API = '/api/celestrak/previous/';

/**
 * One page of that catalogue took 11.5 s in testing (redirect plus a slow
 * origin), so pages are fetched together and each is given a deadline rather
 * than letting one stall the whole layer.
 */
const TLE_API_DEADLINE_MS = 35_000;

export function createSatelliteWatchSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  groups = WATCH_CATALOG_GROUPS,
  tleApiPages = WATCH_TLE_API_PAGES,
} = {}) {
  return {
    /** Azmth and Orbital Radar: one merged CelesTrak catalogue. */
    async readCatalog({ signal } = {}) {
      const byNorad = new Map();
      let stale = false;
      for (const group of groups) {
        signal?.throwIfAborted();
        try {
          const response = await fetchImpl(`/api/celestrak/${group}`, {
            signal,
          });
          if (!response.ok) continue;
          if (response.headers?.get?.('x-tle-cache') === 'STALE-ERROR')
            stale = true;
          const entries = parseTleCatalog(await response.text());
          for (const entry of entries) {
            if (!byNorad.has(entry.norad)) byNorad.set(entry.norad, entry);
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          // One group down still leaves the others usable.
        }
      }
      if (!byNorad.size) throw new Error('No element sets returned');
      return { entries: [...byNorad.values()], stale };
    },

    /**
     * Orbital Radar's first reference: the element sets the proxy cache held
     * before its last refresh. A group with no previous generation answers
     * 404 and simply contributes nothing, so a cold cache is not an error.
     */
    async readPreviousCatalog({ signal } = {}) {
      const byNorad = new Map();
      for (const group of groups) {
        signal?.throwIfAborted();
        try {
          const response = await fetchImpl(`${PREVIOUS_TLE_API}${group}`, {
            signal,
          });
          if (!response.ok) {
            await response.body?.cancel?.().catch?.(() => {});
            continue;
          }
          const entries = parseTleCatalog(await response.text());
          for (const entry of entries) {
            if (!byNorad.has(entry.norad)) byNorad.set(entry.norad, entry);
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          // A cached generation that cannot be read costs the shortcut to a
          // first comparison, never the poll it was meant to accelerate.
        }
      }
      return { entries: [...byNorad.values()] };
    },

    /** War Monitor: the public TLE catalogue, a few pages of twenty. */
    async readTleApi({ signal, pages = tleApiPages } = {}) {
      let failed = 0;
      const requests = [];
      for (let page = 1; page <= pages; page++) {
        requests.push(
          (async () => {
            const controller = new AbortController();
            const timer = setTimeout(
              () => controller.abort(),
              TLE_API_DEADLINE_MS,
            );
            const relay = () => controller.abort();
            signal?.addEventListener('abort', relay, { once: true });
            try {
              const response = await fetchImpl(`${TLE_API}${page}`, {
                signal: controller.signal,
              });
              if (!response.ok) return [];
              const payload = await response.json();
              return Array.isArray(payload?.member) ? payload.member : [];
            } catch {
              // A page that misses its deadline costs its twenty objects only,
              // unless every page missed: then the source is down, and a switch
              // reading "0" would be a quiet lie.
              failed++;
              return [];
            } finally {
              clearTimeout(timer);
              signal?.removeEventListener('abort', relay);
            }
          })(),
        );
      }
      const pagesRead = await Promise.all(requests);
      if (pages > 0 && failed >= pages)
        throw new Error('Catalogue unavailable');
      return { members: pagesRead.flat() };
    },

    /**
     * Space-Track: official element sets plus the public conjunction feed. Both
     * arrive from one authenticated route, so one credential covers the switch;
     * the CDM read is best-effort — element sets still paint when it fails.
     */
    async readSpaceTrack({ signal } = {}) {
      const gpResponse = await fetchImpl('/api/spacetrack/gp', { signal });
      if (gpResponse.status === 503) {
        await gpResponse.body?.cancel?.().catch?.(() => {});
        return { ok: false, error: 'missing-key', entries: [], messages: [] };
      }
      if (!gpResponse.ok)
        throw new Error(`Space-Track HTTP ${gpResponse.status}`);
      const gp = await gpResponse.json();
      let messages = [];
      try {
        const cdmResponse = await fetchImpl('/api/spacetrack/cdm', { signal });
        if (cdmResponse.ok) {
          const cdm = await cdmResponse.json();
          if (Array.isArray(cdm?.messages)) messages = cdm.messages;
        } else {
          await cdmResponse.body?.cancel?.().catch?.(() => {});
        }
      } catch {
        // A conjugation feed that fails costs the conjunction markers, not the
        // element sets that are already in hand.
      }
      return {
        ok: true,
        error: null,
        entries: Array.isArray(gp?.entries) ? gp.entries : [],
        messages,
        stale: Boolean(gp?.stale),
      };
    },

    /**
     * N2YO: satellites above one observer point, through the app's own route.
     * The key is the server's, never the bundle's; a deployment without one
     * answers `no_key`, which the layer reports as a missing key rather than as
     * an empty sky.
     */
    async readN2yo({ lat, lon, radiusDeg = 70, signal } = {}) {
      const query = new URLSearchParams({
        lat: String(Number(lat) || 0),
        lon: String(Number(lon) || 0),
        radius: String(radiusDeg),
      });
      const response = await fetchImpl(`/api/n2yo/above?${query}`, { signal });
      if (response.status === 503) {
        await response.body?.cancel?.().catch?.(() => {});
        return { ok: false, error: 'missing-key', above: [] };
      }
      if (!response.ok) throw new Error(`N2YO HTTP ${response.status}`);
      return parseN2yoPayload(await response.json());
    },
  };
}
