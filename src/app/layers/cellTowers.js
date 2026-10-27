import { createCellTowersLayer } from '../../layers/cellTowers/index.js';

/** Wire the radio-sites layer (ANFR, OpenCelliD) into the catalog. */
export function createApplicationCellTowers(options = {}) {
  return createCellTowersLayer(options);
}
