import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { boundsQuery } from '../viewportPoints/records.js';

// A portable export (package.json): no i18n here.
const msg = (text) => text;

/** The proxy route that answers with radio sites inside a view. */
export const CELL_TOWERS_ROUTE = '/api/cell-towers';

/**
 * Read radio sites inside a view.
 *
 * The proxy decides what it can answer from: the ANFR extract built into this
 * checkout (`npm run towers:build`) covers France with physical sites, and an
 * OpenCelliD key covers the rest of the world with estimated cell positions.
 * When neither is configured it answers 503 with a reason, and the layer shows
 * an unavailable feed rather than an empty map that looks like "nothing here".
 */
export function createCellTowerSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot({ bounds, provider } = {}, { signal } = {}) {
      signal?.throwIfAborted();
      const query = boundsQuery(bounds, { source: provider });
      if (!query) throw new Error(msg('Radio sites need a view'));
      const response = await fetchImpl(`${CELL_TOWERS_ROUTE}?${query}`, {
        signal,
      });
      if (!response.ok) {
        const limited = response.status === 429;
        throw Object.assign(
          new Error(
            limited
              ? msg('Radio-site feed rate limited (HTTP 429)')
              : `Radio-site feed unavailable (HTTP ${response.status})`,
          ),
          {
            status: response.status,
            retryable: limited || response.status >= 500,
            retryAfterMs: limited ? 60000 : null,
            // 503 means no source is configured on this server; retrying
            // cannot fix that, so the row explains the next step instead.
            retryableAfterSetup: response.status === 503,
          },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        8 * 1024 * 1024,
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
