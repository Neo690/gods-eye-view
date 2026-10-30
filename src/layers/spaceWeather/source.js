import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeSpaceWeatherSnapshot } from './records.js';

const DEFAULT_ENDPOINT = '/api/space-weather';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Read one space-weather snapshot from this project's server.
 *
 * SWPC sends CORS headers, but the oval grid is ~900 KB and the phone's asset
 * origin is not the SWPC origin, so the route is the one reader: it caches,
 * trims and hands back the layer's own shape. The answer is validated before
 * it can replace anything on the globe.
 * @param {object} [options]
 * @param {(...args: unknown[]) => Promise<Response>} [options.fetchImpl]
 * @param {string} [options.endpoint]
 * @param {number} [options.timeoutMs]
 * @returns {{getSnapshot: (options?: {signal?: AbortSignal}) => Promise<object>}}
 */
export function createSpaceWeatherSource({
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
        () => controller.abort(new Error('Space weather request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(endpoint, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Space weather HTTP ${response.status}`);
        const payload = await readResponseJsonCapped(
          response,
          MAX_RESPONSE_BYTES,
          controller.signal,
        );
        const snapshot = normalizeSpaceWeatherSnapshot(payload);
        if (!snapshot) throw new Error('Malformed space weather response');
        return snapshot;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
