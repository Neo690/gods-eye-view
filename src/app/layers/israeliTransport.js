import { overlayHost } from './overlayHost.js';
import { createIsraeliTransportLayer } from '../../layers/israeliTransport/index.js';

/** Construct the transport-activity layer on the application's overlay host. */
export function createApplicationIsraeliTransport() {
  return createIsraeliTransportLayer({ overlayHost });
}
