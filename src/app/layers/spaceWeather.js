import { createSpaceWeatherLayer } from '../../layers/spaceWeather/index.js';
import { overlayHost } from './overlayHost.js';

/** Wire NOAA space weather to the application overlay host. */
export function createApplicationSpaceWeather(options) {
  return createSpaceWeatherLayer({ overlayHost, ...options });
}
