/**
 * Where the Sun stands over the Earth, for placing a flare on the globe.
 *
 * A GOES flare is an X-ray event on the Sun and has no ground coordinate.
 * The honest place to draw it is the point directly under the Sun at the
 * flare's peak — the subsolar point — because that is the part of the ionosphere
 * the burst reached first. The card says so instead of implying a location.
 *
 * The declination and right ascension come from the app's one solar model
 * (`src/data/satellitePass.js`); the sidereal angle is computed here so the
 * subsolar longitude uses the same convention as an observer's hour angle.
 * @module layers/spaceWeather/sun
 */
import { solarPositionECI } from '../../data/satellitePass.js';

/** Normalize degrees into [0, 360). */
function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

/** Normalize degrees into (−180, 180]. */
function normalizeLongitude(value) {
  const wrapped = normalizeDegrees(value);
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * Greenwich mean sidereal time in degrees (IAU 1982 polynomial).
 * @param {number} dateMs UTC epoch milliseconds.
 * @returns {number} Degrees in [0, 360).
 */
export function greenwichSiderealDegrees(dateMs) {
  const days = dateMs / 86400000 + 2440587.5 - 2451545.0;
  return normalizeDegrees(
    280.46061837 + 360.98564736629 * days + 0.000387933 * (days / 36525) ** 2,
  );
}

/**
 * The point on the ellipsoid directly under the Sun.
 * @param {number} dateMs UTC epoch milliseconds.
 * @returns {{lat: number, lon: number}} Degrees; longitude in (−180, 180].
 */
export function subsolarPoint(dateMs) {
  const sun = solarPositionECI(dateMs);
  const sidereal = greenwichSiderealDegrees(dateMs);
  return {
    lat: sun.decDeg,
    lon: normalizeLongitude(sun.raDeg - sidereal),
  };
}
