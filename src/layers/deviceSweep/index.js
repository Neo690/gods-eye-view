import { msg, t } from '../../i18n/index.js';
import { createViewportPointsLayer } from '../viewportPoints/engine.js';
import { importScanFile } from './importScan.js';
import { openNoteDialog } from './notes.js';
import {
  DEVICE_SWEEP_COLOURS,
  DEVICE_SWEEP_LEGEND,
  deviceSweepColour,
  deviceSweepHoverTip,
  deviceSweepRow,
} from './presentation.js';
import {
  bindDeviceSweepFileHandler,
  ensureDeviceSweepFileInput,
  openDeviceSweepPicker,
} from './picker.js';
import {
  createGlobePlacePicker,
  flyToSweepPlace,
  openCoordinateDialog,
} from './place.js';
import { createDeviceSweepSource } from './source.js';
import { createDeviceSweepStore } from './store.js';

export {
  SCAN_MAX_DEVICES,
  classifyDevice,
  parseInventory,
  parseNmapScan,
  vendorForMac,
} from './scan.js';
export {
  SWEEP_RING_STEP_DEG,
  createDeviceSweepSource,
  devicesInBounds,
  sweepPointFor,
} from './source.js';
export {
  DEVICE_SWEEP_MAX_BYTES,
  DEVICE_SWEEP_NOTE_MAX,
  DEVICE_SWEEP_STORAGE_KEY,
  DeviceSweepStoreError,
  createDeviceSweepStore,
  deviceSweepKey,
} from './store.js';
export {
  DEVICE_SWEEP_FILE_INPUT_ID,
  bindDeviceSweepFileHandler,
  ensureDeviceSweepFileInput,
  openDeviceSweepPicker,
} from './picker.js';
export {
  createGlobePlacePicker,
  flyToSweepPlace,
  groundPointAt,
  openCoordinateDialog,
  parseCoordinates,
} from './place.js';
export {
  DEVICE_SWEEP_COLOURS,
  DEVICE_SWEEP_LEGEND,
  deviceSweepColour,
  deviceSweepHoverTip,
  deviceSweepRow,
  deviceVerdictLabel,
} from './presentation.js';
export { openNoteDialog };

/** A fix as the two numbers the ring is drawn around, or null. */
function placeFrom(position) {
  const lat = Number(position?.coords?.latitude);
  const lon = Number(position?.coords?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // A receiver with no fix yet answers (0, 0), which is in the Atlantic.
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/** Satellite first, the network provider after: the locate button's policy. */
const PRECISE_FIX = Object.freeze({
  enableHighAccuracy: true,
  maximumAge: 60000,
  timeout: 12000,
});
const NETWORK_FIX = Object.freeze({
  enableHighAccuracy: false,
  maximumAge: 300000,
  timeout: 20000,
});
/** Error codes that mean "no satellite here": ask the network instead. */
const RETRY_ON_NETWORK = new Set([2, 3]);

/**
 * Find the operator's own place, the point the ring is drawn around.
 *
 * The layer never infers a position from an address: a LAN device has none,
 * and the flat is wherever the operator is standing when they ask. Geolocation
 * is requested only from this chip, never at construction.
 *
 * Indoors, where the devices being looked for are, a precise fix usually times
 * out or comes back unavailable; that answer is asked again of the network
 * provider before giving up, because a sweep that cannot be placed draws
 * nothing at all.
 *
 * @returns {Promise<{lat:number, lon:number}>}
 */
function currentPlace() {
  const geolocation = globalThis.navigator?.geolocation;
  if (!geolocation?.getCurrentPosition) {
    return Promise.reject(new Error('geolocation-unavailable'));
  }
  return new Promise((resolve, reject) => {
    const ask = (options, mayRetry) => {
      geolocation.getCurrentPosition(
        (position) => {
          const place = placeFrom(position);
          if (place) resolve(place);
          else if (mayRetry) ask(NETWORK_FIX, false);
          else reject(new Error('geolocation-failed'));
        },
        (error) => {
          if (mayRetry && RETRY_ON_NETWORK.has(error?.code))
            ask(NETWORK_FIX, false);
          else reject(error ?? new Error('geolocation-failed'));
        },
        options,
      );
    };
    ask(PRECISE_FIX, true);
  });
}

/**
 * Own the devices on the operator's own network, read from an inventory they
 * ran.
 *
 * This is the layer behind the hidden-camera sweep: nmap or an ARP table lists
 * what is on the Wi-Fi, this module names the maker from the MAC, reads the
 * ports cameras open, and ranks what is worth walking over to look at. It
 * draws the result at the operator's own place and says, in the row, that the
 * positions are a schematic ring rather than a floor plan.
 *
 * Nothing is scanned from here and nothing is uploaded: the file is read in
 * the page, the verdicts come from the file's own evidence, and the layer is
 * registered as local-only, so no share link can carry it.
 *
 * The place the ring is drawn around can arrive three ways: the browser's
 * location (MY LOCATION), one click on the globe, or typed coordinates. All
 * three write through `store.setPlace`, so a sweep placed without a location
 * permission is the same stored sweep as one placed with it.
 *
 * @param {object} [options]
 * @param {{read: Function, write: Function, setPlace: Function,
 *   setNote: Function, clear: Function}} [options.store]
 * @param {() => Promise<{lat:number, lon:number}>} [options.locate] Test seam.
 * @param {Function} [options.placePickerFactory] Test seam: builds the globe
 *   click picker (see place.js).
 */
export function createDeviceSweepLayer({
  store = createDeviceSweepStore(),
  locate = currentPlace,
  placePickerFactory = createGlobePlacePicker,
} = {}) {
  let feedback = '';
  // The panel hands over the reload to call after an import. Until the row has
  // rendered there is nothing to reload, and that first render reads the store.
  let refreshPanel = () => {};
  // The globe picker needs the camera to turn a click into degrees, and the
  // engine hands the viewer to the layer only in init.
  let viewer = null;
  let placePicker = null;
  let pickingPlace = false;

  /** Read the picked file, then let the row show what it did. */
  async function importFile(file) {
    feedback = await importScanFile({ file, store });
    refreshPanel();
  }

  /** Record a place from any source: a fix, a globe click or typed numbers. */
  function setPlaceFrom(place, { fly = false } = {}) {
    store.setPlace(place);
    feedback = t('Sweep place set for this device');
    if (fly) flyToSweepPlace(viewer, place);
    refreshPanel();
  }

  async function setPlace() {
    try {
      setPlaceFrom(await locate());
    } catch (error) {
      console.warn('[Data:device-sweep] location unavailable:', error);
      feedback = t('Location unavailable on this device');
      refreshPanel();
    }
  }

  /** The globe picker, built once the layer has a viewer to pick on. */
  function placeClickPicker() {
    if (!placePicker) {
      placePicker = placePickerFactory({
        getViewer: () => viewer,
        onPick: (place) => {
          stopPick();
          setPlaceFrom(place);
        },
        onMiss: () => {
          feedback = t('That click missed the globe');
          refreshPanel();
        },
      });
    }
    return placePicker;
  }

  /** Drop an armed globe click: the layer holds no pointer listener idle. */
  function stopPick() {
    placePicker?.disarm();
    pickingPlace = false;
  }

  function armPlacePick() {
    if (placeClickPicker().arm()) {
      pickingPlace = true;
      feedback = t('Click the globe where the sweep should sit');
    } else {
      feedback = t('The globe is not ready for a click yet');
    }
    refreshPanel();
  }

  function disarmPlacePick() {
    stopPick();
    feedback = '';
    refreshPanel();
  }

  function saveNote(key, text) {
    store.setNote(key, text);
    feedback = String(text ?? '').trim()
      ? t('Note saved on this device')
      : t('Note removed');
    refreshPanel();
  }

  const layer = createViewportPointsLayer({
    id: 'device-sweep',
    name: 'Device Sweep',
    icon: '🔎',
    attribution: msg('Your own nmap scan'),
    source: createDeviceSweepSource({ store }),
    colour: DEVICE_SWEEP_COLOURS.unknown,
    pixelSize: 8,
    pointColour: deviceSweepColour,
    legend: DEVICE_SWEEP_LEGEND,
    hoverTip: deviceSweepHoverTip,
    // The row is the only place an import, a refusal or a placed sweep is
    // reported, so its line has to be spoken, not only painted. That holds for
    // every rendering of this layer, which is why it is a property of the layer
    // and not a flag on the row it builds.
    announceInfo: true,
    // The data only changes when the operator imports or moves; a camera move
    // is what re-reads it, so the interval can be long.
    refreshMs: 600000,
    extras: ({ refresh }) => {
      refreshPanel = refresh;
      const { devices, place, importedAt, notes } = store.read();
      const row = deviceSweepRow({
        devices,
        place,
        importedAt,
        feedback,
        pickingPlace,
      });
      return {
        chips: [
          {
            id: 'import',
            label: t('IMPORT SCAN'),
            title: t(
              'For your own spaces only · scan only networks you are authorized to use',
            ),
            onClick: () => openDeviceSweepPicker(),
          },
          {
            id: 'place',
            label: t('MY LOCATION'),
            onClick: () => void setPlace(),
          },
          {
            id: 'place-pick',
            label: row.pick.label,
            active: row.pick.active,
            onClick: () => (pickingPlace ? disarmPlacePick() : armPlacePick()),
          },
          {
            id: 'place-coordinates',
            label: t('COORDINATES'),
            onClick: () =>
              openCoordinateDialog({
                place,
                onSubmit: (typed) => setPlaceFrom(typed, { fly: true }),
              }),
          },
          {
            id: 'note',
            label: t('NOTE'),
            disabled: row.note.disabled,
            onClick: () =>
              openNoteDialog({ devices, notes, onSubmit: saveNote }),
          },
          {
            id: 'clear',
            label: t('CLEAR SCAN'),
            disabled: row.clear.disabled,
            onClick: () => {
              store.clear();
              feedback = t('Scan removed from this device');
              refreshPanel();
            },
          },
        ],
        detail: row.detail,
      };
    },
  });
  // The engine keeps the viewer private, and a globe click needs its camera.
  // Wrapping the three lifecycle methods is smaller than a new engine hook:
  // `init` records the viewer, and `disable`/`destroy` drop the click handler
  // so a sweep that is off cannot place itself behind the operator.
  const initLayer = layer.init.bind(layer);
  layer.init = (scene) => {
    initLayer(scene);
    viewer = scene;
  };
  const disableLayer = layer.disable.bind(layer);
  layer.disable = () => {
    stopPick();
    disableLayer();
  };
  const destroyLayer = layer.destroy.bind(layer);
  layer.destroy = (scene) => {
    stopPick();
    placePicker = null;
    viewer = null;
    destroyLayer(scene);
  };

  // The input exists from construction so a second import reuses it, and so
  // the Android shell always has the element its file chooser answers.
  ensureDeviceSweepFileInput();
  bindDeviceSweepFileHandler(importFile);
  return layer;
}
