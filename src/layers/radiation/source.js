import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeRadiationSnapshot } from './records.js';

const DEFAULT_ENDPOINT = '/api/radiation';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Read one radiation snapshot from this project's server.
 *
 * The browser cannot read the networks directly (two send no CORS headers), so
 * the route is the only source. Its answer is validated before it can replace
 * anything on the globe.
 * @param {object} [options]
 * @param {(...args: unknown[]) => Promise<Response>} [options.fetchImpl]
 * @param {string} [options.endpoint]
 * @param {number} [options.timeoutMs]
 * @returns {{getSnapshot: (options?: {signal?: AbortSignal}) => Promise<object>}}
 */
export function createRadiationSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = DEFAULT_ENDPOINT,
  timeoutMs = 20_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Radiation request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(endpoint, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Radiation HTTP ${response.status}`);
        const payload = await readResponseJsonCapped(
          response,
          MAX_RESPONSE_BYTES,
          controller.signal,
        );
        const snapshot = normalizeRadiationSnapshot(payload);
        if (!snapshot) throw new Error('Malformed radiation response');
        return snapshot;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
