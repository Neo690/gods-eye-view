import { readResponseJsonCapped } from '../../sources/httpBody.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** The proxy route that answers with this server's node health. */
export const NETMON_ROUTE = '/api/netmon';

/**
 * Read the health of the operator's own, authorized nodes.
 *
 * The targets live in the server's `GEV_NETMON_TARGETS`; the server probes
 * them itself (plain TCP connect), so the browser sends no addresses and the
 * endpoint offers nothing to aim for. Unlike the viewport layers there is no
 * view argument: a node list is global and small, so every poll is the same
 * read and the engine's refresh interval is the pacing.
 */
export function createNetmonSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async getSnapshot(_request = {}, { signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(NETMON_ROUTE, {
        signal,
      });
      if (!response.ok) {
        const limited = response.status === 429;
        throw Object.assign(
          new Error(
            limited
              ? msg('Network-monitor feed rate limited (HTTP 429)')
              : `Network-monitor feed unavailable (HTTP ${response.status})`,
          ),
          {
            status: response.status,
            retryable: limited || response.status >= 500,
            retryAfterMs: limited ? 60000 : null,
            // 503 means no target is configured on this server; retrying
            // cannot fix that, so the row explains the next step instead.
            retryableAfterSetup: response.status === 503,
          },
        );
      }
      const payload = await readResponseJsonCapped(
        response,
        2 * 1024 * 1024,
        signal,
      );
      return {
        rows: Array.isArray(payload?.points) ? payload.points : [],
        ageMs: Number(payload?.ageMs) || 0,
        stale: payload?.stale === true,
        truncated: payload?.truncated === true,
        configured: payload?.configured === true,
        unplacedCount:
          Math.max(
            Number(payload?.totalTargets) - Number(payload?.placedTargets),
            0,
          ) || 0,
      };
    },
  };
}
