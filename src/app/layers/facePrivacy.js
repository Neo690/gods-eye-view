import { createFaceLayer } from '../../layers/facePrivacy/index.js';
import { createFaceOverlay } from '../../layers/facePrivacy/overlay.js';

/**
 * Wire face privacy to the application.
 *
 * The layer asks the server (`/api/face/analyze`), so the source is the
 * reference one and needs no keys; the camera comes from the CCTV layer
 * instance, because "the selected camera" is that layer's answer and not a
 * second piece of state this one would have to keep in step.
 *
 * The blur draws over the CCTV panel, so it is built here, where the page
 * exists: the layer keeps the geometry, the panel keeps the picture, and
 * this is the one place that knows both. A document-less build (a test, the
 * headless catalog) gets the no-op overlay and answers in the row only.
 */
export function createApplicationFacePrivacy({ source, camera } = {}) {
  return createFaceLayer({
    source,
    camera,
    overlay: createFaceOverlay({ documentRef: globalThis.document }),
  });
}
