import * as Cesium from 'cesium';

/**
 * The horizon test that hides far-side aurora cells.
 *
 * Cesium's `EllipsoidalOccluder.isPointVisible` is exact, and an exact test on
 * a point that sits *on* the boundary flips with every pixel of movement: a
 * hand jittering at the limb made single cells blink on and off while the rest
 * of the oval stayed put. The fix is a deadband, not a different test — keep a
 * cell visible a hair past the horizon, and only reveal it once it is clearly
 * inside. Two occluders read the same camera position at slightly different
 * altitudes: a farther camera has a wider visible cap, so it decides whether a
 * shown cell stays shown; a nearer one has a narrower cap, so it decides
 * whether a hidden cell comes back.
 *
 * The deadband is a fraction of the camera distance, which stays imperceptible
 * in pixels at any altitude (0.15 % of a 12 000 km view moves the edge by about
 * a quarter of a degree) while swallowing hand tremor and camera easing.
 */
export const HORIZON_HYSTERESIS = 0.0015;

/**
 * @param {object} [options]
 * @param {Cesium.Ellipsoid} [options.ellipsoid]
 * @param {number} [options.hysteresis] Fraction of the camera distance.
 */
export function createHorizonCuller({
  ellipsoid = Cesium.Ellipsoid.WGS84,
  hysteresis = HORIZON_HYSTERESIS,
} = {}) {
  const lenient = new Cesium.EllipsoidalOccluder(ellipsoid);
  const strict = new Cesium.EllipsoidalOccluder(ellipsoid);
  const scratch = new Cesium.Cartesian3();
  const band = Number.isFinite(hysteresis) ? Math.max(0, hysteresis) : 0;
  return {
    /** Place both tests at one camera position; call once per frame. */
    setCamera(cameraPosition) {
      lenient.cameraPosition = Cesium.Cartesian3.multiplyByScalar(
        cameraPosition,
        1 + band,
        scratch,
      );
      strict.cameraPosition = Cesium.Cartesian3.multiplyByScalar(
        cameraPosition,
        1 - band,
        scratch,
      );
    },
    /**
     * Whether a point should show, given whether it shows now.
     * @param {Cesium.Cartesian3} position
     * @param {boolean} currentlyVisible
     */
    isVisible(position, currentlyVisible) {
      return (currentlyVisible ? lenient : strict).isPointVisible(position);
    },
  };
}
