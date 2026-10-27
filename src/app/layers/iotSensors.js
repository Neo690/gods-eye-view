import { createIotSensorsLayer } from '../../layers/iotSensors/index.js';

/** Wire the connected-objects layer (openSenseMap, TTN) into the catalog. */
export function createApplicationIotSensors(options = {}) {
  return createIotSensorsLayer(options);
}
