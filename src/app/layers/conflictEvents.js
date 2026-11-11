import {
  createConflictEventsLayer,
  createConflictEventsSource,
} from '../../layers/conflict-events/index.js';
import { overlayHost } from './overlayHost.js';

/**
 * Wire conflict-event observations to the application overlay host.
 *
 * The catalog instantiates this with no arguments, so the same-origin source is
 * the default here — a missing source is a wiring error, not a valid state.
 */
export function createApplicationConflictEvents({
  source = createConflictEventsSource(),
  ...options
} = {}) {
  return createConflictEventsLayer({ overlayHost, source, ...options });
}
