/**
 * @module layers/osmPlaces/source
 * @description Read named OpenStreetMap places for one bounded view through
 * the app's own Overpass proxy. The browser never names an upstream host: the
 * query is built here from a view box, and the proxy decides which mirror, if
 * any, answers it.
 *
 * The proxy is opt-in: it answers only operator-configured mirrors, never a
 * public one. An unconfigured install therefore says so instead of drawing an
 * empty map that would read as "no places here".
 */

import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { OVERPASS_URL, QUERY_LIMIT, osmPlacesQuery } from './policy.js';
import { normalizePlaces } from './records.js';

// A portable package (no i18n): the error stays English data and the layer
// panel shows it translated.
const msg = (text) => text;

/** The response cap is generous for points; the proxy already capped bytes. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function boundedView(bounds) {
  const { south, west, north, east } = bounds || {};
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (north <= south || east <= west) return null;
  return { south, west, north, east };
}

function sourceError(
  message,
  { status = 0, retryable = true, retryAfterMs = null } = {},
) {
  return Object.assign(new Error(msg(message)), {
    status,
    retryable,
    retryAfterMs,
  });
}

/**
 * Construct the bounded places source without starting a request.
 */
export function createOverpassPlacesSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  let configured = null;

  async function ensureConfigured(signal) {
    if (configured !== null) {
      if (!configured)
        throw sourceError('Overpass endpoint not configured', {
          retryable: false,
        });
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
    if (!configured)
      throw sourceError('Overpass endpoint not configured', {
        retryable: false,
      });
  }

  async function getSnapshot({ bounds } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    await ensureConfigured(signal);
    const view = boundedView(bounds);
    if (!view) throw new TypeError('A bounded places viewport is required');

    const response = await fetchImpl(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(osmPlacesQuery(view))}`,
      signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      if (response.status === 429) {
        throw sourceError('Overpass rate-limited', {
          status: 429,
          retryAfterMs: 60_000,
        });
      }
      if (response.status === 504) {
        throw sourceError('Overpass timed out', { status: 504 });
      }
      if (response.status === 400) {
        throw sourceError('Overpass could not complete the query', {
          status: 400,
          retryable: false,
        });
      }
      throw sourceError('Overpass temporarily unavailable', {
        status: response.status,
        retryable: response.status >= 500,
      });
    }

    const stale = response.headers.get('x-overpass-cache') === 'STALE';
    const payload = await readResponseJsonCapped(
      response,
      MAX_RESPONSE_BYTES,
      signal,
    );
    signal?.throwIfAborted();
    // The proxy rejects query errors upstream; validating here too keeps a
    // malformed or partial answer from becoming an authoritative empty map.
    if (!Array.isArray(payload?.elements) || payload.remark)
      throw sourceError('Overpass could not complete the query', {
        retryable: false,
      });

    const { rows, saturated } = normalizePlaces(payload.elements);
    return {
      rows,
      stale,
      truncated: saturated || payload.elements.length >= QUERY_LIMIT,
      ageMs: 0,
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
