import {
  createInsiderLayer,
  createInsiderSource,
} from '../../layers/insider/index.js';

/**
 * Wire the insider filing list into the application catalog.
 *
 * The catalog instantiates this with no arguments, so the same-origin source is
 * the default here — a missing source is a wiring error, not a valid state.
 */
export function createApplicationInsider({
  source = createInsiderSource(),
  ...options
} = {}) {
  return createInsiderLayer({ source, ...options });
}
