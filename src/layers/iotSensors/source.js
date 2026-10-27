import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { boundsQuery } from '../viewportPoints/records.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** The proxy route both providers answer on. */
export const IOT_ROUTE = '/api/iot/sensors';

/**
 * Request the connected objects inside a view through this app's own proxy.
 * The browser never talks to openSenseMap or the TTN mapper directly: the proxy
 * caches, caps and attributes, so a pan across a city cannot become a burst of
 * upstream calls.
 */
export function createIotSensorSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ bounds, provider } = {}, { signal } = {}) {
      signal?.throwIfAborted();
      const query = boundsQuery(bounds, { source: provider });
      if (!query) throw new Error(msg('Connected objects need a view'));
      const response = await fetchImpl(`${IOT_ROUTE}?${query}`, { signal });
      if (!response.ok) {
        const limited = response.status === 429;
        throw Object.assign(
          new Error(
            // HTTP errors are matched by FEED_ERROR_PATTERNS in ui/statusText.js.
            limited
              ? msg('Connected-objects feed rate limited (HTTP 429)')
              : `Connected-objects feed unavailable (HTTP ${response.status})`,
          ),
          {
            status: response.status,
            retryable: limited || response.status >= 500,
            retryAfterMs: limited ? 60000 : null,
          },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        4 * 1024 * 1024,
        signal,
      );
      return {
        rows: Array.isArray(payload?.points) ? payload.points : [],
        ageMs: Number(payload?.ageMs) || 0,
        stale: payload?.stale === true,
        truncated: payload?.truncated === true,
      };
    },
  };
}
