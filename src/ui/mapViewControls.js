/**
 * Zoom and device position — the two thumb actions on the right edge.
 *
 * The console already zooms from the keyboard, the wheel, the voice agent and
 * a dragged map, but a phone has none of those: a pinch works, and nothing
 * else does. These buttons call the same Cesium camera API the voice action
 * does, stepped from the current camera height so the move feels the same at
 * a city block and at the full globe.
 *
 * The locate button reads the DEVICE's own GPS through the browser's
 * geolocation API, which is what makes the view agree with the phone. It is a
 * toggle: the first press starts a watch and flies to the fix; from then on
 * EVERY fix carries the camera with it, at the height and pitch the operator
 * chose, which is what makes a moving vehicle stay under the crosshair the
 * way it does on a phone map. Panning or zooming by hand releases the camera
 * without losing the position: the marker keeps moving, the button turns into
 * one that recentres, and a second press on it while following stops the watch
 * and removes the marker.
 */
import * as Cesium from 'cesium';
import { t } from '../i18n/index.js';

/** Share of the current height one press covers: three presses halve the distance. */
export const ZOOM_STEP_RATIO = 0.55;
/** Never close in tighter than this, whatever the math says. */
const MIN_ZOOM_STEP_M = 12;
/**
 * Asking the platform for a fix, precise first and approximate after.
 *
 * `enableHighAccuracy: true` is the satellite/GNSS request. Indoors, in a
 * valley or with the phone's precise location switched off, it answers
 * POSITION_UNAVAILABLE or times out — so a second watch asks the network
 * provider (Wi-Fi and cell towers, i.e. "GPS via internet") and that fix is
 * the one that lands the view. A permission refusal (code 1) is not retried:
 * the network provider needs the same grant.
 */
export const PRECISE_FIX_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  maximumAge: 5000,
  timeout: 12000,
});
export const NETWORK_FIX_OPTIONS = Object.freeze({
  enableHighAccuracy: false,
  maximumAge: 120000,
  timeout: 20000,
});
/** Geolocation error codes that mean "no satellite, try the network". */
const RETRY_ON_NETWORK = new Set([2, 3]);

/** First look at a fix: high enough to read the neighbourhood, tilted a little. */
export const LOCATE_RANGE_M = 2200;
export const LOCATE_PITCH_DEG = -55;
const LOCATE_PITCH = Cesium.Math.toRadians(LOCATE_PITCH_DEG);
export const DEVICE_ENTITY_ID = 'device-location';

/** A follow step shorter than this would only jitter the view. */
const FOLLOW_MIN_MOVE_M = 1.5;

/**
 * Step the camera in or out from its current height.
 * @param {{camera?: object, scene?: object}} viewer
 * @param {'in'|'out'} direction
 * @returns {boolean} Whether a camera was moved.
 */
export function zoomBy(viewer, direction) {
  const camera = viewer?.camera;
  if (!camera) return false;
  const height = Number(camera.positionCartographic?.height);
  const base = Number.isFinite(height) && height > 0 ? height : 1_000_000;
  const step = Math.max(MIN_ZOOM_STEP_M, base * ZOOM_STEP_RATIO);
  // A flight in progress owns the camera; a press is the operator taking over.
  camera.cancelFlight?.();
  if (direction === 'in') camera.zoomIn(step);
  else camera.zoomOut(step);
  viewer.scene?.requestRender?.();
  return true;
}

/**
 * The fix as a camera-ready position: longitude, latitude and the accuracy
 * radius in metres, with the (0, 0) null island a cold GPS reports dropped.
 * @param {GeolocationPosition} position
 * @returns {{lon: number, lat: number, accuracy: number, cartesian: Cesium.Cartesian3}|null}
 */
export function readFix(position) {
  const coords = position?.coords;
  const lat = Number(coords?.latitude);
  const lon = Number(coords?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  const accuracy = Number(coords?.accuracy);
  return {
    lon,
    lat,
    accuracy: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 25,
    cartesian: Cesium.Cartesian3.fromDegrees(lon, lat),
  };
}

/**
 * First look at a fix: a short flight down to it, facing north.
 *
 * Cesium's flights are driven by the render loop, and this console renders on
 * demand when nothing else is moving. If the flight has not carried the camera
 * at least half way by the time it should be over, the view is set there
 * outright — a locate button that silently does nothing is worse than a cut.
 *
 * @param {object} viewer
 * @param {{lon: number, lat: number}} fix
 * @param {{settleDelayMs?: number}} [options]
 */
export function flyToFix(viewer, fix, { settleDelayMs = 2400 } = {}) {
  const camera = viewer?.camera;
  if (!camera) return false;
  const view = {
    destination: Cesium.Cartesian3.fromDegrees(
      fix.lon,
      fix.lat,
      LOCATE_RANGE_M,
    ),
    orientation: {
      heading: 0,
      pitch: LOCATE_PITCH,
      roll: 0,
    },
  };
  const before = camera.positionWC
    ? Cesium.Cartesian3.clone(camera.positionWC)
    : null;
  const span = before
    ? Cesium.Cartesian3.distance(before, view.destination)
    : 0;
  camera.flyTo?.({ ...view, duration: 1.6 });
  globalThis.setTimeout?.(() => {
    if (!before || !camera.positionWC) return;
    const moved = Cesium.Cartesian3.distance(before, camera.positionWC);
    if (moved >= span / 2) return;
    camera.cancelFlight?.();
    camera.setView?.(view);
    viewer.scene?.requestRender?.();
  }, settleDelayMs);
  return true;
}

/**
 * Carry the camera to a new fix, keeping what the operator chose to look at:
 * the same height, pitch and heading, moved over the device.
 *
 * This is a view set rather than a flight: fixes arrive about once a second,
 * and a flight per fix would never settle. Below `FOLLOW_MIN_MOVE_M` the view
 * is left alone, so a stationary phone does not redraw the globe.
 *
 * @param {object} viewer
 * @param {{lon: number, lat: number, previous?: {lon: number, lat: number}|null}} fix
 * @returns {boolean} Whether the camera moved.
 */
export function followFix(viewer, fix) {
  const camera = viewer?.camera;
  if (!camera?.setView) return false;
  const previous = fix?.previous;
  if (
    previous &&
    Number.isFinite(previous.lat) &&
    Number.isFinite(previous.lon)
  ) {
    const metres = Cesium.Cartesian3.distance(
      Cesium.Cartesian3.fromDegrees(previous.lon, previous.lat),
      Cesium.Cartesian3.fromDegrees(fix.lon, fix.lat),
    );
    if (metres < FOLLOW_MIN_MOVE_M) return false;
  }
  const height = Number(camera.positionCartographic?.height);
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      fix.lon,
      fix.lat,
      Number.isFinite(height) && height > 0 ? height : LOCATE_RANGE_M,
    ),
    orientation: {
      heading: Number.isFinite(camera.heading) ? camera.heading : 0,
      pitch: Number.isFinite(camera.pitch) ? camera.pitch : LOCATE_PITCH,
      roll: 0,
    },
  });
  viewer.scene?.requestRender?.();
  return true;
}

/**
 * The marker: a pip at the device, ringed by the accuracy the fix claims.
 *
 * No text label: console text on the globe goes through the world-overlay host
 * (src/ui/worldOverlay*), and a Cesium entity label here would be a second,
 * untranslated way of drawing it.
 */
function addDeviceMarker(viewer, fix) {
  const state = { fix };
  const accent = Cesium.Color.fromCssColorString('#00d4ff');
  const entity = viewer.entities.add({
    id: DEVICE_ENTITY_ID,
    position: new Cesium.CallbackProperty(() => state.fix.cartesian, false),
    point: {
      pixelSize: 12,
      color: accent,
      outlineColor: Cesium.Color.fromCssColorString('#04121c'),
      outlineWidth: 3,
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    ellipse: {
      semiMajorAxis: new Cesium.CallbackProperty(
        () => state.fix.accuracy,
        false,
      ),
      semiMinorAxis: new Cesium.CallbackProperty(
        () => state.fix.accuracy,
        false,
      ),
      material: accent.withAlpha(0.12),
      outline: true,
      outlineColor: accent.withAlpha(0.5),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    },
  });
  return {
    entity,
    update(next) {
      state.fix = next;
    },
    remove() {
      viewer.entities.remove(entity);
    },
  };
}

/**
 * Wire the three buttons and keep their accessible state current.
 *
 * @param {object} options
 * @param {object} options.viewer            Cesium viewer.
 * @param {{zoomIn?: Element, zoomOut?: Element, locate?: Element}} options.elements
 * @param {(text: string) => void} [options.showToast]
 * @param {(fix: object) => void} [options.flyTo] How to show a first fix.
 * @param {Geolocation} [options.geolocation] Defaults to the page's own.
 * @returns {{zoom: (direction: 'in'|'out') => boolean, stopLocating: () => void, destroy: () => void}}
 */
export function bindMapViewControls({
  viewer,
  elements,
  showToast,
  flyTo,
  geolocation = globalThis.navigator?.geolocation,
}) {
  const navigateToFix = flyTo || ((fix) => flyToFix(viewer, fix));
  const zoomIn = elements?.zoomIn;
  const zoomOut = elements?.zoomOut;
  const locate = elements?.locate;
  const removers = [];
  let watchId = null;
  let marker = null;
  let destroyed = false;
  /** 'precise' until the satellite attempt fails, then 'network'. */
  let stage = 'precise';
  /** 'off' | 'following' (camera rides along) | 'attached' (only the marker). */
  let mode = 'off';
  /** The last fix, so a second press can recentre without waiting for GPS. */
  let lastFix = null;
  /** Camera moves we asked for, whose moveEnd must not release following. */
  let ownMoves = 0;

  const listen = (element, handler) => {
    if (!element) return;
    element.addEventListener('click', handler);
    removers.push(() => element.removeEventListener('click', handler));
  };

  const setPressed = (pressed) => {
    locate?.setAttribute('aria-pressed', String(pressed));
    const label = pressed
      ? t('Stop following your position')
      : t('Centre on my position');
    locate?.setAttribute('aria-label', label);
    locate?.setAttribute('title', label);
  };

  /** Waiting for a fix. The button stays tappable: a second press cancels. */
  const setWaiting = (next) => {
    locate?.setAttribute('aria-busy', String(next));
  };

  /** Our own camera moves must not read as the operator taking over. */
  const claimCameraMove = () => {
    ownMoves += 1;
  };

  const setMode = (next) => {
    mode = next;
    setPressed(next === 'following');
  };

  const stopLocating = () => {
    if (watchId !== null) geolocation?.clearWatch?.(watchId);
    watchId = null;
    stage = 'precise';
    marker?.remove?.();
    marker = null;
    lastFix = null;
    setWaiting(false);
    setMode('off');
  };

  /**
   * Panning, rotating or zooming by hand is the operator taking the camera
   * back. The watch keeps running — a phone map keeps the dot moving — and the
   * button becomes the one that recentres.
   */
  const onCameraMoveEnd = () => {
    if (ownMoves > 0) {
      ownMoves -= 1;
      return;
    }
    if (destroyed || mode !== 'following') return;
    setMode('attached');
  };
  viewer?.camera?.moveEnd?.addEventListener?.(onCameraMoveEnd);
  removers.push(() =>
    viewer?.camera?.moveEnd?.removeEventListener?.(onCameraMoveEnd),
  );

  const startLocating = () => {
    if (!geolocation?.watchPosition) {
      showToast?.(t('This device has no location access.'));
      return;
    }
    setWaiting(true);
    setPressed(true);
    let first = true;

    const onFix = (position) => {
      if (destroyed) return;
      const fix = readFix(position);
      if (!fix) return;
      setWaiting(false);
      const previous = lastFix;
      lastFix = fix;
      if (!marker) {
        marker = addDeviceMarker(viewer, fix);
      } else {
        marker.update(fix);
      }
      if (first) {
        first = false;
        claimCameraMove();
        navigateToFix(fix);
        setMode('following');
        showToast?.(t('Following your position'));
      } else if (mode === 'following') {
        // The whole point of the toggle: the vehicle stays under the camera.
        // Only a move that actually happens may claim a moveEnd.
        if (followFix(viewer, { ...fix, previous })) claimCameraMove();
      }
      viewer.scene?.requestRender?.();
    };

    /** One watch, in the stage named by `options`. */
    const watch = (options, nextStage) => {
      stage = nextStage;
      if (watchId !== null) geolocation.clearWatch?.(watchId);
      watchId = geolocation.watchPosition(
        onFix,
        (error) => {
          if (destroyed) return;
          // No satellite fix: ask the network provider before giving up.
          if (stage === 'precise' && RETRY_ON_NETWORK.has(error?.code)) {
            watch(NETWORK_FIX_OPTIONS, 'network');
            return;
          }
          stopLocating();
          showToast?.(
            error?.code === 1
              ? t('Location access is blocked for this app.')
              : t('Location unavailable'),
          );
        },
        options,
      );
    };

    watch(PRECISE_FIX_OPTIONS, 'precise');
  };

  listen(zoomIn, () => {
    if (!zoomBy(viewer, 'in')) return;
  });
  listen(zoomOut, () => {
    if (!zoomBy(viewer, 'out')) return;
  });
  listen(locate, () => {
    if (mode === 'following') {
      stopLocating();
      return;
    }
    if (mode === 'attached') {
      // Recentre on the fix we already have, then ride along again.
      setMode('following');
      if (lastFix) {
        claimCameraMove();
        navigateToFix(lastFix);
      }
      return;
    }
    startLocating();
  });

  setPressed(false);

  return {
    zoom: (direction) => zoomBy(viewer, direction),
    stopLocating,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopLocating();
      for (const remove of removers.splice(0)) remove();
    },
  };
}
