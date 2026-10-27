import { createViewportPointsLayer } from '../viewportPoints/engine.js';
import { createCellTowerSource } from './source.js';

export { CELL_TOWERS_ROUTE, createCellTowerSource } from './source.js';
export * from '../viewportPoints/records.js';

/**
 * Providers this layer can read, in panel order.
 *
 * ANFR lists sites, stations and bands; OpenCelliD estimates a position per
 * logical cell. They are different objects, so the row says which one is drawn
 * instead of averaging them into one confidence.
 */
export const CELL_TOWER_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'anfr', label: 'ANFR (France)' }),
  Object.freeze({ id: 'opencellid', label: 'OpenCelliD' }),
]);

/**
 * Own one display of radio sites: antenna supports published by the French
 * spectrum agency, or reported cell measurements elsewhere.
 *
 * @param {object} [options]
 * @param {{getSnapshot: Function}} [options.source]
 */
export function createCellTowersLayer({
  source = createCellTowerSource(),
} = {}) {
  return createViewportPointsLayer({
    id: 'cell-towers',
    name: 'Radio Sites',
    icon: '📶',
    attribution: 'ANFR · OpenCelliD (CC BY-SA)',
    source,
    sources: CELL_TOWER_PROVIDERS,
    colour: '#ffb648',
    pixelSize: 6,
    refreshMs: 300000,
  });
}
