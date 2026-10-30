import { createFishingEffortLayer } from '../../layers/fishingEffort/index.js';

/**
 * Wire the fishing-effort layer to the application source. The Global Fishing
 * Watch token lives on the server (`/api/fishing-effort`), so there is nothing
 * to read here and nothing to refresh when a key changes.
 */
export function createApplicationFishingEffort(options) {
  return createFishingEffortLayer(options);
}
