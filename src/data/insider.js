import { createInsiderSource } from '../layers/insider/index.js';
import { createApplicationInsider } from '../app/layers/insider.js';
export * from '../layers/insider/index.js';

/** Wire the standalone source and the application layer owner. */
export function createInsiderLayer({
  source = createInsiderSource(),
  ...options
} = {}) {
  return createApplicationInsider({ source, ...options });
}
