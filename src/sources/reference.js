import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';
import { createEcccAirQualitySource } from '../layers/airQuality/source.js';
import { createWfigsPerimeterSource } from '../layers/perimeters/source.js';
import { createBundledCableSource } from '../layers/submarineCables/bundledSource.js';
import { createAdsbGnssSource } from '../layers/gnss/source.js';
import { createRadiationSource } from '../layers/radiation/source.js';
import { createSpaceWeatherSource } from '../layers/spaceWeather/source.js';
import { createOrbitChangeSource } from '../layers/orbitChanges/source.js';
import { createSatelliteWatchSource } from '../layers/satelliteWatch/sources.js';
import { createFishingEffortSource } from '../layers/fishingEffort/sources.js';
import { createPlateReaderSource } from '../layers/alprReader/sources.js';

/** Construct the existing reference feeds independently of application setup. */
export function createReferenceSources() {
  return {
    earthquakes: createUsgsEarthquakeSource(),
    'air-quality': createEcccAirQualitySource(),
    'fire-perimeters': createWfigsPerimeterSource(),
    cables: createBundledCableSource(),
    'gnss-integrity': createAdsbGnssSource(),
    radiation: createRadiationSource(),
    'space-weather': createSpaceWeatherSource(),
    'orbit-changes': createOrbitChangeSource(),
    'satellite-watch': createSatelliteWatchSource(),
    'fishing-effort': createFishingEffortSource(),
    'plate-reader': createPlateReaderSource(),
  };
}
