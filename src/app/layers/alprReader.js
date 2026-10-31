import { createPlateReaderLayer } from '../../layers/alprReader/index.js';

/**
 * Wire the plate reader to the application.
 *
 * The reader asks the server (`/api/alpr`), so the source is the reference one
 * and needs no keys; the camera comes from the CCTV layer instance, because
 * "the selected camera" is that layer's answer and not a second piece of state
 * this one would have to keep in step.
 */
export function createApplicationPlateReader({ source, camera } = {}) {
  return createPlateReaderLayer({ source, camera });
}
