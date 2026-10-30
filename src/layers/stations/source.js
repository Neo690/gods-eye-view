/**
 * @module layers/stations/source
 * @description Read named OpenStreetMap railway stations for one bounded view
 * through the app's own Overpass proxy. The browser never names an upstream
 * host: the query is built here from a view box, and the proxy decides which
 * mirror, if any, answers it.
 */

import { OVERPASS_URL, clampViewport, stationsQuery } from './policy.js';
import { normalizeStations } from './records.js';

// A portable package (no i18n): the error stays English data and the layer
// panel shows it translated.
const msg = (text) => text;

/** Construct the bounded station source without starting a request. */
export function createOverpassStationSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  // The proxy is opt-in: it answers only operator-configured mirrors, never a
  // public one. Probing once keeps an unconfigured install from polling a
  // route that can only ever answer “disabled”, and lets the layer say so.
  let configured = null;
  async function ensureConfigured(signal) {
    if (configured !== null) {
      if (!configured) throw new Error(msg('Overpass endpoint not configured'));
      return;
    }
    try {
      const response = await fetchImpl(`${OVERPASS_URL}/status`, { signal });
      const body = await response.json();
      configured = body?.configured === true;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      // An unreachable status route is not proof of a missing endpoint: let
      // the query below answer for itself rather than blame the operator.
      configured = true;
    }
    if (!configured) throw new Error(msg('Overpass endpoint not configured'));
  }

  async function getSnapshot(box, { signal } = {}) {
    signal?.throwIfAborted();
    await ensureConfigured(signal);
    const view = clampViewport(box);
    if (!view) throw new TypeError('A bounded station viewport is required');
    const response = await fetchImpl(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(stationsQuery(view))}`,
      signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      const message =
        response.status === 429
          ? 'Overpass rate-limited'
          : response.status === 504
            ? 'Overpass timed out'
            : response.status === 400
              ? 'Overpass rejected the station query'
              : 'Overpass temporarily unavailable';
      throw Object.assign(new Error(message), {
        failureReason:
          response.status === 429
            ? 'rate_limited'
            : response.status === 504
              ? 'timeout'
              : 'unavailable',
      });
    }
    const stale = response.headers.get('x-overpass-cache') === 'STALE';
    const payload = await response.json();
    signal?.throwIfAborted();
    // The proxy rejects query errors upstream; validating here too keeps a
    // malformed or partial answer from becoming an authoritative empty map.
    if (!Array.isArray(payload?.elements) || payload.remark) {
      throw new Error('Overpass returned an incomplete station response');
    }
    const { records, saturated } = normalizeStations(payload.elements);
    return {
      records,
      stale,
      saturated,
      retrievedAt: new Date().toISOString(),
      box: view,
    };
  }
  return {
    getSnapshot,
    attribution: {
      name: 'OpenStreetMap',
      description: 'OpenStreetMap contributors (ODbL 1.0)',
      text: '© OpenStreetMap contributors',
      href: 'https://www.openstreetmap.org/copyright',
    },
  };
}
