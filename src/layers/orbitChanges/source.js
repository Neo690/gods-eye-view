/**
 * Read the element sets the orbit-change layer diffs.
 *
 * Every group comes through the app's own CelesTrak route, which caches the
 * last body and serves it marked stale when upstream is down — the same path
 * the satellites layer uses, so there is one proxy, one rate budget and one
 * place that knows the upstream URL.
 *
 * @module layers/orbitChanges/source
 */
import { ORBIT_CHANGE_GROUPS, parseTleCatalog } from './model.js';

/**
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 * @returns {{readCatalog: function({signal?: AbortSignal}): Promise<{entries: Array<object>, groups: Array<object>, stale: boolean}>}}
 */
export function createOrbitChangeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  groups = ORBIT_CHANGE_GROUPS,
} = {}) {
  const allowed = new Set(groups);
  return {
    /**
     * One merged catalog. A group that fails is reported, not thrown: two
     * groups of three still give a usable comparison.
     */
    async readCatalog({ signal } = {}) {
      const byNorad = new Map();
      const reported = [];
      let stale = false;
      for (const group of groups) {
        if (!allowed.has(group)) throw new TypeError('Unknown satellite group');
        signal?.throwIfAborted();
        try {
          const response = await fetchImpl(`/api/celestrak/${group}`, {
            signal,
          });
          const text = response.ok ? await response.text() : '';
          const isStale =
            response.headers?.get?.('x-tle-cache') === 'STALE-ERROR';
          if (isStale) stale = true;
          const entries = parseTleCatalog(text);
          for (const entry of entries) {
            // `visual` overlaps `stations`; keep the first, which came from the
            // group listed earlier.
            if (!byNorad.has(entry.norad)) byNorad.set(entry.norad, entry);
          }
          reported.push({
            group,
            ok: response.ok,
            count: entries.length,
            stale: isStale,
          });
        } catch (error) {
          if (signal?.aborted) throw error;
          reported.push({
            group,
            ok: false,
            count: 0,
            stale: false,
            error: error?.message || 'unavailable',
          });
        }
      }
      return { entries: [...byNorad.values()], groups: reported, stale };
    },
  };
}
