import { createNamedMarkers } from './namedMarkers.js';
import { createModel } from './model.js';
import { createRendering } from './rendering.js';
import { createIngestion } from './ingestion.js';
import { createViewport } from './viewport.js';
import { createSelection } from './selection.js';
import { createControls } from './controls.js';
import { createLifecycle } from './lifecycle.js';
import { createState } from './state.js';
import { patrolSitesFromRecords } from './patrolSites.js';

/** Construct one layer with its own scene state and supplied application services. */
export function createInstallationsLayer({ services, source, overlayHost }) {
  if (
    typeof source?.getMappedSites !== 'function' ||
    typeof source?.searchNearby !== 'function'
  )
    throw new TypeError('An installation source is required');
  const state = createState({ services });
  const parts = {};
  const context = { state, services, parts, source, overlayHost };
  parts.model = createModel(context);
  parts.rendering = createRendering(context);
  parts.namedMarkers = createNamedMarkers(context);
  parts.ingestion = createIngestion(context);
  parts.viewport = createViewport(context);
  parts.selection = createSelection(context);
  parts.controls = createControls(context);
  parts.lifecycle = createLifecycle(context);
  // Mapped sites are fixed, so the Sentinel can walk to them: `getAllPositions`
  // is the contract its patrol reads, and `getPatrolSites` is the explicit
  // alias Radio Sites already carries. Without either, the patrol skipped this
  // layer entirely and no installation was ever inspected.
  const patrolSites = (maxCount = 500) =>
    patrolSitesFromRecords(state.records, maxCount);
  return Object.assign(
    {},
    parts.controls.methods,
    parts.lifecycle.methods,
    parts.ingestion?.methods,
    {
      approximateSurfaceDistanceM: parts.model.approximateSurfaceDistanceM,
      classifyGoogleMilitaryPlace: parts.model.classifyGoogleMilitaryPlace,
      installationSourceLabel: parts.model.installationSourceLabel,
      installationSurfaceHeightM: parts.rendering.installationSurfaceHeightM,
      installationWithinViewport: parts.model.installationWithinViewport,
      installationResponseSaturated: parts.model.installationResponseSaturated,
      installationRetryDelayMs: parts.viewport.installationRetryDelayMs,
      getPatrolSites: patrolSites,
      getAllPositions: (maxCount = 500) =>
        patrolSites(maxCount).map(({ latitude, longitude }) => ({
          latitude,
          longitude,
        })),
    },
  );
}
export { createInstallationSource } from './source.js';
