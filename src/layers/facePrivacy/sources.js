/**
 * The face-privacy layer's one call: read the selected camera on the server.
 *
 * The endpoint already exists (`/api/face/analyze`): it decodes the camera's
 * own frame, reports every face as a box in that frame's pixels, and keeps no
 * roster — analysis only, no identity. The browser sends a camera id and
 * receives boxes, so a metered link spends a few hundred bytes rather than a
 * frame.
 * @module layers/facePrivacy/sources
 */

/** A refusal the panel can explain, rather than a generic failure. */
export class FaceAnalysisError extends Error {
  constructor(code, message, { status = 0, detail = '' } = {}) {
    super(message);
    this.name = 'FaceAnalysisError';
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
export function createFaceAnalysisSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    /**
     * Analyse one camera's current frame for people.
     *
     * @param {string} cameraId Registered CCTV camera id.
     * @param {{signal?:AbortSignal}} [options]
     * @returns {Promise<{camera:object, faces:Array<object>, frame:object,
     *   model:object, ms:object, cached:boolean}>}
     */
    async read(cameraId, { signal } = {}) {
      if (typeof cameraId !== 'string' || !cameraId)
        throw new FaceAnalysisError('no_camera', 'No camera is selected');
      signal?.throwIfAborted();
      let response = null;
      try {
        response = await fetchImpl('/api/face/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cameraId }),
          cache: 'no-store',
          signal,
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw new FaceAnalysisError(
          'offline',
          'The face analysis is unreachable',
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
        throw new FaceAnalysisError(
          payload?.error || `http_${response.status}`,
          payload?.detail || 'The face route refused the request',
          { status: response.status, detail: payload?.detail || '' },
        );
      }
      if (!Array.isArray(payload?.faces))
        throw new FaceAnalysisError(
          'malformed',
          'The face route answered without faces',
        );
      return payload;
    },
  };
}
