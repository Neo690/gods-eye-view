import { createRadiationLayer } from '../../layers/radiation/index.js';

/** Wire radiation readings to the application catalog. */
export function createApplicationRadiation(options) {
  return createRadiationLayer({ ...options });
}
