import { createRadiationLayer } from '../../layers/radiation/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire radiation readings to the application catalog and its value labels. */
export function createApplicationRadiation(options) {
  return createRadiationLayer({ overlayHost, ...options });
}
