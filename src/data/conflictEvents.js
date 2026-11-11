import { createConflictEventsSource } from '../layers/conflict-events/index.js';
import { createApplicationConflictEvents } from '../app/layers/conflictEvents.js';
export * from '../layers/conflict-events/index.js';

/** Wire the standalone source and application overlay owner. */
export function createConflictEventsLayer({
  source = createConflictEventsSource(),
  ...options
} = {}) {
  return createApplicationConflictEvents({ source, ...options });
}
