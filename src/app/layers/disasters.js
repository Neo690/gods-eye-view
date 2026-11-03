import {
  createGlobalDisastersLayer,
  createGlobalDisastersSource,
} from '../../layers/disasters/index.js';
/**
 * Wire the Global disasters records source into the application registry. In
 * the browser the Copernicus EMS complement goes through the app's own
 * `/api/copernicus-ems` route; everything else is browser-direct.
 */
export function createApplicationGlobalDisasters(options = {}) {
  return createGlobalDisastersLayer({
    source: createGlobalDisastersSource(),
    ...options,
  });
}
