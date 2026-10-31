import { createPlateReaderLayer } from '../../layers/alprReader/index.js';
import { createPlateOverlay } from '../../layers/alprReader/overlay.js';

/**
 * Wire the plate reader to the application.
 *
 * The reader asks the server (`/api/alpr`), so the source is the reference one
 * and needs no keys; the camera comes from the CCTV layer instance, because
 * "the selected camera" is that layer's answer and not a second piece of state
 * this one would have to keep in step.
 *
 * The overlay draws over the CCTV panel, so it is built here, where the page
 * exists: the layer keeps the geometry, the panel keeps the picture, and this
 * is the one place that knows both. A document-less build (a test, the headless
 * catalog) gets the no-op overlay and reads exactly as before.
 */
export function createApplicationPlateReader({ source, camera } = {}) {
  return createPlateReaderLayer({
    source,
    camera,
    overlay: createPlateOverlay({ documentRef: globalThis.document }),
  });
}
