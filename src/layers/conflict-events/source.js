import { normalizeConflictSnapshot } from './records.js';

const DEFAULT_URL = '/api/conflicts';

/**
 * Same-origin acquisition source for conflict events.
 *
 * The API key never reaches the browser: the server proxy behind `/api/conflicts`
 * holds the ACLED credentials and falls back to a keyless provider when they are
 * absent. Validation happens before the snapshot can replace displayed events.
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
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(resolved, {
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
      const provider = payload?.provider === 'acled' ? 'acled' : 'gdelt';
      const rows = normalizeConflictSnapshot(payload, { provider });
      if (!rows) throw new Error('Malformed conflicts response');
      return rows;
    },
  };
}
