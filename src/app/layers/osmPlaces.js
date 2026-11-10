import { createOsmPlacesLayer } from '../../layers/osmPlaces/index.js';

/** Wire the OpenStreetMap places layer into the catalog. */
export function createApplicationOsmPlaces(options = {}) {
  return createOsmPlacesLayer(options);
}
