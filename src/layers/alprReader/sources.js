/**
 * The plate reader's one call: read the selected camera on the server.
 *
 * The image never leaves the server: the browser sends a camera id and receives
 * plate strings, so a phone on a metered link spends a few hundred bytes rather
 * than a frame. The model set lives beside the route (`/api/alpr`).
 * @module layers/alprReader/sources
 */

/** A refusal the panel can explain, rather than a generic failure. */
export class PlateReaderError extends Error {
  constructor(code, message, { status = 0, detail = '' } = {}) {
    super(message);
    this.name = 'PlateReaderError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/**
 * @param {{fetchImpl?:Function}} [options]
 * @returns {{read: (cameraId:string, options?:{signal?:AbortSignal})
 *   => Promise<object>}}
 */
export function createPlateReaderSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * Read every plate in one camera's current frame.
     *
     * @param {string} cameraId Registered CCTV camera id.
     * @param {{signal?:AbortSignal}} [options]
     * @returns {Promise<{camera:object, plates:Array<object>, frame:object,
     *   model:object, ms:object, cached:boolean}>}
     */
    async read(cameraId, { signal } = {}) {
      if (typeof cameraId !== 'string' || !cameraId)
        throw new PlateReaderError('no_camera', 'No camera is selected');
      signal?.throwIfAborted();
      let response = null;
      try {
        response = await fetchImpl('/api/alpr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cameraId }),
          cache: 'no-store',
          signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw new PlateReaderError(
          'offline',
          'The plate reader is unreachable',
        );
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      signal?.throwIfAborted();
      if (!response.ok) {
        throw new PlateReaderError(
          payload?.error || `http_${response.status}`,
          payload?.detail || 'The plate reader refused the request',
          { status: response.status, detail: payload?.detail || '' },
        );
      }
      if (!Array.isArray(payload?.plates))
        throw new PlateReaderError(
          'malformed',
          'The plate reader answered without plates',
        );
      return payload;
    },
  };
}
