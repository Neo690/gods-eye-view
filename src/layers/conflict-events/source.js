import { normalizeConflictSnapshot } from './records.js';

const DEFAULT_URL = '/api/conflicts';

/**
 * Same-origin acquisition source for conflict events.
 *
 * The API key never reaches the browser: the server proxy behind `/api/conflicts`
 * holds the ACLED credentials and answers `no_key` when they are absent. There
 * is no keyless fallback. Validation happens before the snapshot can replace
 * displayed events.
 */
export function createConflictEventsSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  url,
} = {}) {
  let endpoint = url;
  if (!endpoint) {
    try {
      endpoint = import.meta.env?.VITE_CONFLICT_EVENTS_URL;
    } catch {
      endpoint = null;
    }
  }
  const resolved = endpoint || DEFAULT_URL;
  return {
    async getSnapshot({ signal, force = false } = {}) {
      signal?.throwIfAborted();
      // The proxy caches a successful read for ten minutes. A manual refresh
      // asks it for a new upstream read instead of that cached snapshot.
      const requestUrl = force
        ? `${resolved}${resolved.includes('?') ? '&' : '?'}refresh=1`
        : resolved;
      const response = await fetchImpl(requestUrl, {
        signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        // The proxy states the reason in its body (`no_key`, `auth`, ...).
        // Keeping that code is what lets the panel explain the failure
        // instead of repeating a bare HTTP status.
        let code = null;
        try {
          const payload = await response.json();
          if (typeof payload?.error === 'string' && payload.error) {
            code = payload.error;
          }
        } catch {
          code = null;
        }
        throw Object.assign(
          new Error(
            code ? `Conflicts ${code}` : `Conflicts HTTP ${response.status}`,
          ),
          { code: code || `http_${response.status}` },
        );
      }
      const payload = await response.json();
      signal?.throwIfAborted();
      // ACLED is the only provider this route serves. A payload that does not
      // name it is malformed, not a second provider's snapshot.
      const rows =
        payload?.provider === 'acled'
          ? normalizeConflictSnapshot(payload)
          : null;
      if (!rows) throw new Error('Malformed conflicts response');
      return {
        rows,
        // The proxy stamps the upstream read, not the cache hit, so the panel
        // can state the real age of the displayed snapshot.
        generatedAt: Number.isFinite(payload.generatedAt)
          ? payload.generatedAt
          : Date.now(),
      };
    },
  };
}
