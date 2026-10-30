import { createSatelliteWatchLayer } from '../../layers/satelliteWatch/index.js';
import { overlayHost } from './overlayHost.js';

/**
 * Wire the four satellite sources to the application overlay host.
 *
 * N2YO's account key is not read here at all: `/api/n2yo/above` holds it on the
 * server, exactly like every other keyed provider. A deployment without one
 * answers `no_key`, and the switch says the key is missing instead of showing
 * an empty sky.
 */
export function createApplicationSatelliteWatch(options) {
  return createSatelliteWatchLayer({ overlayHost, ...options });
}
