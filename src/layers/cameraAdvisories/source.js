import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { normalizeAdvisoryPayload } from './records.js';

// A portable export (package.json): no i18n here. Failures stay English data;
// the Layers panel shows them translated.
const msg = (text) => text;

/** The proxy route that joins the catalogue with public advisories. */
export const CAMERA_ADVISORIES_ROUTE = '/api/camera-advisories';

/** The answer can take a few seconds on a cold server (feed + brand queries). */
const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * Read the advisory join for this server's catalogue.
 *
 * There is no view argument and no camera address: the answer is a catalogue
 * fact, and the route refuses to touch a device.
 *
 * @param {object} [options]
 * @param {(...args: unknown[]) => Promise<Response>} [options.fetchImpl]
 * @param {string} [options.endpoint]
 * @param {number} [options.timeoutMs]
 */
export function createCameraAdvisoriesSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = CAMERA_ADVISORIES_ROUTE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return {
    async getSnapshot(_request = {}, { signal } = {}) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Camera-advisory request timed out')),
        timeoutMs,
      );
      try {
        const response = await fetchImpl(endpoint, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          throw Object.assign(
            new Error(
              // HTTP errors are matched by FEED_ERROR_PATTERNS in ui/statusText.js.
              response.status === 429
                ? msg('Camera-advisory feed rate limited (HTTP 429)')
                : response.status === 503
                  ? msg(
                      'Camera-advisory feed disabled on this server (HTTP 503)',
                    )
                  : `Camera-advisory feed unavailable (HTTP ${response.status})`,
            ),
            {
              status: response.status,
              retryable,
              retryAfterMs: response.status === 429 ? 60000 : null,
              // 503 is a deliberate kill switch, not a transient failure.
              retryableAfterSetup: response.status === 503,
            },
          );
        }
        const payload = await readResponseJsonCapped(
          response,
          8 * 1024 * 1024,
          controller.signal,
        );
        const snapshot = normalizeAdvisoryPayload(payload);
        if (!snapshot)
          throw new Error(msg('Malformed camera-advisory response'));
        return snapshot;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
