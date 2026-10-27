import { createViewportPointsLayer } from '../viewportPoints/engine.js';
import { createIotSensorSource } from './source.js';

export { createIotSensorSource, IOT_ROUTE } from './source.js';
export * from '../viewportPoints/records.js';

/** Providers this layer can read, in panel order. */
export const IOT_PROVIDERS = Object.freeze([
  // i18n-ignore: product name
  Object.freeze({ id: 'opensensemap', label: 'openSenseMap' }),
  // i18n-ignore: product name
  Object.freeze({ id: 'ttn', label: 'TTN LoRaWAN' }),
]);

/**
 * Own one display of connected objects: citizen sensor boxes from openSenseMap
 * (published under PDDL 1.0) or LoRaWAN gateways listed by The Things Network's
 * Packet Broker mapper, whose gateway locations owners may hide.
 *
 * Both are positions a provider publishes, not measurements taken here, and
 * neither is a complete inventory of the devices in view.
 *
 * @param {object} [options]
 * @param {{getSnapshot: Function}} [options.source]
 */
export function createIotSensorsLayer({
  source = createIotSensorSource(),
} = {}) {
  return createViewportPointsLayer({
    id: 'iot-sensors',
    name: 'Connected Objects',
    icon: '📟',
    attribution: 'openSenseMap · TTN',
    source,
    sources: IOT_PROVIDERS,
    colour: '#3ef0c4',
    pixelSize: 6,
    // Devices do not move; a slower interval keeps upstream calls rare.
    refreshMs: 180000,
  });
}
