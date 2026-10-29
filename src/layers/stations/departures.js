/**
 * @module layers/stations/departures
 * @description Read the live departure board for one mapped station.
 *
 * The browser names a position, never an upstream host: this asks the app's own
 * `/api/rail/departures` route, which joins the SNCF static GTFS with its
 * realtime timetable. A station the operator does not know answers 404 and gets
 * no board at all — silence is better than the nearest city's departures.
 */

export const RAIL_BOARD_URL = '/api/rail/departures';

/** Construct the board reader without starting a request. */
export function createRailDepartureSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  /**
   * @param {{lat:number, lon:number}} position Station coordinates.
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<object|null>} Board payload, or null when the operator
   *   publishes no station here.
   */
  async function getBoard({ lat, lon }, { signal } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const url = `${RAIL_BOARD_URL}?lat=${lat}&lon=${lon}`;
    const response = await fetchImpl(url, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error('Rail board unavailable'), {
        status: response.status,
      });
    }
    const body = await response.json();
    if (!body || !Array.isArray(body.departures)) return null;
    return body;
  }

  return { getBoard };
}
