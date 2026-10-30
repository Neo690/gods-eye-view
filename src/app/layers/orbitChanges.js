import { createOrbitChangesLayer } from '../../layers/orbitChanges/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire CelesTrak element-set diffing to the application overlay host. */
export function createApplicationOrbitChanges(options) {
  return createOrbitChangesLayer({ overlayHost, ...options });
}
