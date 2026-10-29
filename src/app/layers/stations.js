import { createRailwayStationsLayer } from '../../layers/stations/index.js';
import { createOverpassStationSource } from '../../layers/stations/source.js';
import { createRailDepartureSource } from '../../layers/stations/departures.js';
import { overlayHost } from './overlayHost.js';

/**
 * Wire mapped railway stations to the application overlay host.
 *
 * The station source is built here because it reads the app's own Overpass
 * proxy and needs no operator-supplied credential: a station is a mapped place,
 * not a keyed feed. The departure reader is the same shape of decision — it
 * asks `/api/rail/departures`, and a station the national operator does not
 * publish simply has no board.
 */
export function createApplicationRailwayStations({
  source = createOverpassStationSource(),
  departures = createRailDepartureSource(),
  ...options
} = {}) {
  return createRailwayStationsLayer({
    overlayHost,
    source,
    departures,
    ...options,
  });
}
