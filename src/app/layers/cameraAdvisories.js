import { createCameraAdvisoriesLayer } from '../../layers/cameraAdvisories/index.js';

/** Wire the published-advisory join into the application catalog. */
export function createApplicationCameraAdvisories(options = {}) {
  return createCameraAdvisoriesLayer(options);
}
