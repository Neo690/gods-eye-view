import { createNetmonLayer } from '../../layers/netmon/index.js';

/** Wire the operator-node network-monitor layer into the catalog. */
export function createApplicationNetmon(options = {}) {
  return createNetmonLayer(options);
}
