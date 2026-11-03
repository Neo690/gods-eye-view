import { createGlobalDisastersSource } from '../layers/disasters/index.js';
import { createApplicationGlobalDisasters } from '../app/layers/disasters.js';
export * from '../layers/disasters/index.js';
/** Wire the standalone records source and application display owner. */
export function createGlobalDisastersLayer({
  source = createGlobalDisastersSource(),
  ...options
} = {}) {
  return createApplicationGlobalDisasters({ source, ...options });
}
export default createGlobalDisastersLayer();
