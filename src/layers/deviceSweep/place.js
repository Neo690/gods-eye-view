import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { t } from '../../i18n/index.js';
import { createSweepDialog, styleSweepField } from './dialog.js';

/**
 * Placing the sweep without a location fix.
 *
 * A desktop browser often refuses the location permission, and a sweep that
 * cannot be placed draws nothing at all. So the place can also be given
 * directly: one click on the globe, or two typed numbers. Both paths end in
 * `store.setPlace`, the same call MY LOCATION makes, so all three share one
 * stored place and none of them asks the network anything.
 *
 * A LAN device has no geography of its own, so this is the operator saying
 * WHERE THEY ARE, not where a camera sits: the ring is drawn around it.
 */

/** Two signed decimal degrees, latitude first, however a keyboard writes them. */
const COORDINATE_PAIR =
  /^([+-]?\d{1,3}(?:[.,]\d+)?)[\s,;]+([+-]?\d{1,3}(?:[.,]\d+)?)$/;

/**
 * Read typed coordinates.
 *
 * Latitude comes first, as every map and GPS receiver writes it. A decimal
 * comma is accepted because that is what a French or Spanish keyboard types,
 * so "48,8566, 2,3522" reads as 48.8566, 2.3522 — but the two numbers are
 * never swapped to make a guess fit: a sweep drawn in the wrong place is
 * worse than no sweep at all.
 *
 * @param {string} text
 * @returns {{lat:number, lon:number}|null} null when the text is not a pair
 *   of coordinates.
 */
export function parseCoordinates(text) {
  const match = COORDINATE_PAIR.exec(String(text ?? '').trim());
  if (!match) return null;
  const lat = Number(match[1].replace(',', '.'));
  const lon = Number(match[2].replace(',', '.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * Where a screen point lands on the globe, in degrees, or null when the ray
 * missed the ellipsoid (a click on the sky, or outside the globe).
 *
 * @param {object} viewer
 * @param {{x:number, y:number}} position Screen pixel, as the click reported it.
 * @returns {{lat:number, lon:number}|null}
 */
export function groundPointAt(viewer, position) {
  const ellipsoid = viewer?.scene?.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84;
  const onGround = viewer?.camera?.pickEllipsoid?.(position, ellipsoid);
  if (!onGround) return null;
  const cartographic = Cesium.Cartographic.fromCartesian(onGround, ellipsoid);
  if (!cartographic) return null;
  const lat = Cesium.Math.toDegrees(cartographic.latitude);
  const lon = Cesium.Math.toDegrees(cartographic.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

/**
 * A one-click place picker on the globe.
 *
 * It binds its own LEFT_CLICK handler on the canvas and removes it as soon as
 * a click lands, so the layer holds no pointer listener while it is idle. A
 * click that misses the globe is reported and leaves the picker armed: the
 * operator already clicked, and asking for a second click is cheaper than
 * making them re-arm. While another tool holds the pointer (a draw session,
 * say), the click belongs to that tool and places nothing.
 *
 * @param {object} options
 * @param {() => object} options.getViewer The layer's current viewer.
 * @param {(place: {lat:number, lon:number}) => void} options.onPick
 * @param {() => void} [options.onMiss]
 * @param {(canvas: object) => object} [options.handlerFactory] Test seam.
 * @returns {{arm: () => boolean, disarm: () => void, isArmed: () => boolean}}
 */
export function createGlobePlacePicker({
  getViewer,
  onPick,
  onMiss = () => {},
  handlerFactory = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
} = {}) {
  let handler = null;

  function disarm() {
    handler?.destroy?.();
    handler = null;
  }

  function arm() {
    disarm();
    const viewer = getViewer?.();
    const canvas = viewer?.scene?.canvas;
    if (!canvas) return false;
    handler = handlerFactory(canvas);
    handler.setInputAction((movement) => {
      if (!isPointerFree()) return;
      const place = groundPointAt(viewer, movement?.position);
      if (!place) {
        onMiss();
        return;
      }
      disarm();
      onPick?.(place);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return true;
  }

  return { arm, disarm, isArmed: () => handler !== null };
}

/** The field's opening value: the current place, or empty. */
function coordinatesText(place) {
  if (!place) return '';
  return `${place.lat.toFixed(6)}, ${place.lon.toFixed(6)}`;
}

/**
 * Look at the place the sweep was just given.
 *
 * A globe click needs no flight — the place is already under the pointer —
 * but typed coordinates can be a continent away, and a saved place off screen
 * would leave the operator with an empty globe and no reason why.
 *
 * @param {object} viewer
 * @param {{lat:number, lon:number}} place
 * @param {{rangeM?: number}} [options]
 * @returns {boolean} Whether a camera was there to move.
 */
export function flyToSweepPlace(viewer, place, { rangeM = 2000 } = {}) {
  const camera = viewer?.camera;
  if (!place || !camera?.flyTo) return false;
  camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(place.lon, place.lat, rangeM),
    duration: 1.6,
  });
  return true;
}

/**
 * Ask for the place as typed coordinates.
 *
 * @param {object} [options]
 * @param {Document} [options.documentRef] Test seam.
 * @param {{lat:number, lon:number}|null} [options.place] Prefilled current place.
 * @param {(place: {lat:number, lon:number}) => void} [options.onSubmit]
 * @returns {HTMLDialogElement|null} null where there is no document (tests, SSR).
 */
export function openCoordinateDialog({
  documentRef = globalThis.document,
  place = null,
  onSubmit,
} = {}) {
  const dialog = createSweepDialog({
    title: t('Place the sweep'),
    documentRef,
  });
  if (!dialog) return null;
  const doc = dialog.element.ownerDocument ?? documentRef;

  const field = doc.createElement('label');
  field.textContent = t('Coordinates');
  Object.assign(field.style, { display: 'block' });
  const input = styleSweepField(doc.createElement('input'));
  input.type = 'text';
  input.value = coordinatesText(place);
  input.placeholder = '48.8566, 2.3522';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.inputMode = 'decimal';
  field.append(input);
  dialog.body.append(field);

  dialog.button(t('SET PLACE'), { type: 'submit' });

  dialog.form.addEventListener('submit', (event) => {
    event.preventDefault?.();
    const typed = parseCoordinates(input.value);
    if (!typed) {
      dialog.status.textContent = t(
        'Enter latitude and longitude, for example 48.8566, 2.3522',
      );
      input.focus?.();
      return;
    }
    dialog.close();
    onSubmit?.(typed);
  });

  input.focus?.();
  input.select?.();
  return dialog.element;
}
