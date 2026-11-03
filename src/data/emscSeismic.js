import { createEmscEarthquakeSource } from '../layers/emscSeismic/index.js';
import { createApplicationEmscSeismic } from '../app/layers/emscSeismic.js';
export * from '../layers/emscSeismic/index.js';
/** Wire the standalone source and application overlay owner. */
export function createEmscSeismicLayer({
  source = createEmscEarthquakeSource(),
  ...options
} = {}) {
  return createApplicationEmscSeismic({ source, ...options });
}
export default createEmscSeismicLayer();
