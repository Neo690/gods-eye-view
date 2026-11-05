// The Sentinel camera follow: an opt-in companion for the camera, never a
// rival for it.
//
// The layer's checkbox asks the view to drift toward the spider while it
// patrols. The drift is gentle on purpose and defers in every sense that
// matters:
//   - it converges exponentially toward the spider's position at a hard speed
//     cap, so it reads as a slow pan a viewer can follow with their eye, not
//     as a chase;
//   - it moves only the sub-camera point — the eye's height, heading, pitch
//     and roll are carried through untouched, so the shot the operator framed
//     is the shot they keep;
//   - it stops dead whenever someone else is moving the camera: a tool that
//     holds the pointer, a flight the application started, or the operator's
//     own pointer or wheel on the canvas. After a gesture ends it waits out a
//     short cooldown (Cesium keeps inertia after the pointer lifts) and then
//     resumes by drifting from wherever the camera is *now* — a follow that
//     never snaps, because the step it takes is always a share of the
//     remaining distance, never the whole of it.
//
// Nothing here is a module the server imports, so Cesium is imported freely
// and tests inject a camera double plus the Cesium module to pair with it.
// @module layers/aiAgent/follow

import * as CesiumModule from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';

/**
 * Exponential convergence rate, per second. 0.9 closes about 41 % of the
 * remaining distance in the first second — a few seconds from a far diversion,
 * barely perceptible once the camera is near the spider.
 */
export const FOLLOW_RATE_PER_S = 0.9;

/**
 * Hard cap on the drift, degrees per second. Proportional-only convergence
 * would exactly chase a diversion ten continents away at absurd speed; the
 * cap keeps the worst case a steady, readable pan.
 */
export const FOLLOW_MAX_SPEED_DEG_PER_S = 30;

/** Cooldown after a pointer gesture ends, ms (Cesium inertia trails the lift). */
export const FOLLOW_RELEASE_COOLDOWN_MS = 700;

/** Cooldown after a wheel step, ms (zoom arrives as a burst of wheel events). */
export const FOLLOW_WHEEL_COOLDOWN_MS = 350;

/** Below this the drift is over: calling setView at 60 fps for sub-degree noise is waste. */
const STEP_EPSILON_DEG = 1e-9;

/**
 * Shortest signed longitude change, degrees, from one longitude to another.
 * The straight subtraction +350.endsWith turns -10; wrap to the short way.
 * @param {number} fromDeg
 * @param {number} toDeg
 * @returns {number} within [-180, 180], 0 on a non-finite input.
 */
export function shortestLongitudeDeltaDeg(fromDeg, toDeg) {
  const from = Number(fromDeg);
  const to = Number(toDeg);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  const span = (((to - from) % 360) + 360) % 360;
  return span > 180 ? span - 360 : span;
}

/**
 * One step of the drift toward a target, degrees. Pure, so the convergence
 * policy is testable without a camera: a share of the remaining distance,
 * bounded by the speed cap.
 * @param {number} deltaDeg Signed remaining distance.
 * @param {number} dtSec Frame seconds.
 * @returns {number} Signed step, 0 when either input is not a useful number.
 */
export function followStepDeg(deltaDeg, dtSec) {
  if (!Number.isFinite(deltaDeg) || !Number.isFinite(dtSec) || dtSec <= 0)
    return 0;
  const share = 1 - Math.exp(-FOLLOW_RATE_PER_S * dtSec);
  const limited = FOLLOW_MAX_SPEED_DEG_PER_S * dtSec;
  return Math.max(-limited, Math.min(limited, deltaDeg * share));
}

const clampLatitude = (value) => Math.max(-89.9, Math.min(89.9, value));

const finiteOr = (value, fallback) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

/** Pose read back from the camera and re-supplied to setView. */
function currentOrientation(camera) {
  return {
    heading: finiteOr(camera?.heading, 0),
    pitch: finiteOr(camera?.pitch, -Math.PI / 2),
    roll: finiteOr(camera?.roll, 0),
  };
}

/**
 * Build the follow controller.
 *
 * @param {object} [options]
 * @param {object} [options.camera] a Cesium camera (or a test double with
 *   `positionCartographic`, `heading/pitch/roll`, `moving`, `setView`).
 * @param {{latDeg:number, lonDeg:number, visible:boolean}} [options.state] the
 *   layer's live spider state; read-only here.
 * @param {EventTarget} [options.canvas] the globe canvas, for pause-on-gesture
 *   listeners; without one the follow simply never sees gestures and pauses on
 *   only the other gates.
 * @param {() => number} [options.now] clock seam (tests).
 * @param {object} [options.cesium] Cesium module seam (tests).
 * @returns {object} { setEnabled, isEnabled, step, destroy }
 */
export function createSpiderCameraFollow({
  camera = undefined,
  state = {},
  canvas = undefined,
  now = defaultNow,
  cesium = undefined,
} = {}) {
  const Cesium = cesium ?? CesiumModule;
  let enabled = false;
  let destroyed = false;
  let dragging = false;
  let pauseUntil = 0;
  const listeners = [];

  /** @returns {boolean} Paused right now: own gesture, cooldown, claimed pointer, or dead. */
  const paused = () =>
    destroyed || dragging || now() < pauseUntil || !isPointerFree();

  const bind = (target, type, listener, options) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, listener, options);
    listeners.push({ target, type, listener, options });
  };

  bind(canvas, 'pointerdown', () => {
    dragging = true;
    pauseUntil = Number.POSITIVE_INFINITY;
  });
  bind(canvas, 'mousedown', () => {
    dragging = true;
    pauseUntil = Number.POSITIVE_INFINITY;
  });
  bind(canvas, 'touchstart', () => {
    dragging = true;
    pauseUntil = Number.POSITIVE_INFINITY;
  });
  // A gesture event can arrive without its natural pair (a pointer that left
  // the canvas mid-drag), so every end-shaped event both clears the drag and
  // schedules the cooldown; an extra one is harmless.
  for (const type of [
    'pointerup',
    'mouseup',
    'touchend',
    'touchcancel',
    'pointercancel',
  ]) {
    bind(canvas, type, () => {
      dragging = false;
      pauseUntil = now() + FOLLOW_RELEASE_COOLDOWN_MS;
    });
  }
  bind(
    canvas,
    'wheel',
    () => {
      pauseUntil = now() + FOLLOW_WHEEL_COOLDOWN_MS;
    },
    { passive: true },
  );

  return {
    /** @returns {boolean} Whether the follow is switched on at all. */
    get isEnabled() {
      return enabled;
    },

    setEnabled(next) {
      enabled = next === true;
      if (!enabled) pauseUntil = 0;
    },

    /** True when every gate that would stop the drift is closed. Read-only. */
    get isPausedNow() {
      return paused();
    },

    /**
     * One frame of the drift, after the layer's tick has advanced the walk —
     * so the camera chases where the spider is, not where it was.
     * @param {number} dtSec Frame seconds, same dt the walk used.
     * @returns {boolean} Whether the camera moved.
     */
    step(dtSec) {
      if (!enabled || paused()) return false;
      const carto = camera?.positionCartographic;
      if (!Cesium?.Math?.toDegrees || !Cesium?.Cartesian3?.fromDegrees)
        return false;
      if (!carto) return false;
      if (camera.moving === true) return false; // a flight owns the camera
      if (state?.visible !== true) return false;
      const latDeg = Cesium.Math.toDegrees(carto.latitude);
      const lonDeg = Cesium.Math.toDegrees(carto.longitude);
      const heightM = carto.height;
      if (![latDeg, lonDeg, heightM].every(Number.isFinite)) return false;
      const stepLat = followStepDeg(
        clampLatitude(Number(state.latDeg) || 0) - latDeg,
        dtSec,
      );
      const stepLon = followStepDeg(
        shortestLongitudeDeltaDeg(lonDeg, Number(state.lonDeg) || 0),
        dtSec,
      );
      if (
        (Math.abs(stepLat) < STEP_EPSILON_DEG &&
          Math.abs(stepLon) < STEP_EPSILON_DEG) ||
        (stepLat === 0 && stepLon === 0)
      )
        return false;
      try {
        camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(
            lonDeg + stepLon,
            latDeg + stepLat,
            heightM,
          ),
          orientation: currentOrientation(camera),
        });
      } catch {
        // A camera refusing a pose (a wrong scene mode, a NaN) is not this
        // module's crash: skip the frame, the next one re-reads the state.
        return false;
      }
      return true;
    },

    /** Drop the gesture listeners; the layer teardown already stopped ticking. */
    destroy() {
      destroyed = true;
      enabled = false;
      for (const { target, type, listener, options } of listeners) {
        try {
          target.removeEventListener(type, listener, options);
        } catch {
          // A canvas already gone with the page cannot take one more removal.
        }
      }
      listeners.length = 0;
    },
  };
}

function defaultNow() {
  return typeof performance === 'object' && performance?.now
    ? performance.now()
    : Date.now();
}
