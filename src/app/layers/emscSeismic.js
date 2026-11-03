import { createEmscSeismicLayer } from '../../layers/emscSeismic/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire EMSC earthquake observations to the application overlay host. */
export function createApplicationEmscSeismic(options) {
  return createEmscSeismicLayer({ overlayHost, ...options });
}
