import { DEFAULT_DAYS, normalizeEffort } from './model.js';

/**
 * Reads the app's own `/api/fishing-effort` route. The token stays on the
 * server; a deployment without one answers `503 no_key`, which this source
 * reports as a missing key rather than as an empty ocean.
 *
 * @module layers/fishingEffort/sources
 */
export function createFishingEffortSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * @param {{west:number, east:number, south:number, north:number}} bounds
     * @param {{days?:number, signal?:AbortSignal}} [options]
     */
    async getSnapshot({
      west,
      east,
      south,
      north,
      days = DEFAULT_DAYS,
      signal,
    } = {}) {
      const query = new URLSearchParams({
        west: String(west),
        east: String(east),
        south: String(south),
        north: String(north),
        days: String(days),
      });
      const response = await fetchImpl(`/api/fishing-effort?${query}`, {
        signal,
      });
      if (response.status === 503) {
        await response.body?.cancel?.().catch?.(() => {});
        return {
          ok: false,
          error: 'missing-key',
          ...normalizeEffort(null),
          days,
        };
      }
      if (!response.ok)
        throw new Error(`Fishing effort HTTP ${response.status}`);
      const answer = normalizeEffort(await response.json());
      return { ok: true, error: null, ...answer, days };
    },
  };
}
