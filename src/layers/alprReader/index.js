/**
 * Plate Reader: read the plates of the CCTV camera the map has selected.
 *
 * This layer draws nothing on the globe. It is a row with one action — read
 * the selected camera now — and the plates it found, because a plate is not a
 * place: dropping a car's registration onto a map pin would publish it to
 * everyone looking at the screen and to every share link, while the answer
 * itself only means anything next to the frame it came from.
 *
 * Nothing here is persisted. The text lives in this closure until the next
 * read, is never written to layer state, and is gone when the tab closes or the
 * layer is turned off; the server keeps its own copy for a few seconds only.
 *
 * The read is on demand rather than on a timer: a timer would turn the panel
 * into a watcher of whatever camera happened to be selected, which is not what
 * switching a layer on should mean.
 * @module layers/alprReader
 */
import { t } from '../../i18n/index.js';
import { PLATE_READER_LAYER_ID, isCachedAnswer, plateLines } from './model.js';

export { PLATE_READER_LAYER_ID } from './model.js';
export { createPlateReaderSource, PlateReaderError } from './sources.js';

/**
 * @param {object} options
 * @param {{read: Function}} options.source Server reader (see `./sources.js`).
 * @param {{getParams?: Function}} [options.camera] The CCTV layer, asked for
 *   the camera it currently has selected.
 * @param {Function} [options.now] Clock, replaced by the tests.
 */
export function createPlateReaderLayer({
  source,
  camera,
  now = () => Date.now(),
} = {}) {
  if (typeof source?.read !== 'function')
    throw new TypeError('Plate reader requires a read source');

  let _viewer = null;
  let _enabled = false;
  let _busy = false;
  let _request = null;
  let _result = null;
  let _error = null;
  let _lastReadAt = null;
  let _readCameraId = null;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  /** The camera the CCTV layer has selected, or null when it has none. */
  const selectedCameraId = () => {
    try {
      const id = camera?.getParams?.()?.selectedCameraId;
      return typeof id === 'string' && id ? id : null;
    } catch {
      return null;
    }
  };

  /** Forget the answer when it no longer belongs to the selected camera. */
  const resultFor = (cameraId) =>
    _result && _readCameraId === cameraId ? _result : null;

  /**
   * Read the selected camera once.
   *
   * Concurrent clicks share one request: a second read asked for while the
   * first is in flight would spend another inference on the same frame.
   */
  async function readSelected() {
    if (!_enabled || _busy) return null;
    const cameraId = selectedCameraId();
    if (!cameraId) {
      _error = { code: 'no_camera', detail: '' };
      notify();
      return null;
    }
    _busy = true;
    _error = null;
    notify();
    _request = new AbortController();
    try {
      const payload = await source.read(cameraId, { signal: _request.signal });
      _result = payload;
      _readCameraId = cameraId;
      _lastReadAt = now();
      console.log(
        `[Data:PlateReader] ${cameraId}: ${payload.plates.length} plate(s)`,
      );
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') return null;
      _error = {
        code: error?.code || 'read_failed',
        detail: error?.detail || error?.message || '',
      };
      _result = null;
      _readCameraId = null;
      return null;
    } finally {
      _request = null;
      _busy = false;
      notify();
    }
  }

  return {
    id: PLATE_READER_LAYER_ID,
    name: 'Plate Reader',
    icon: '🔎',
    source: 'ONNX · fast-alpr port',
    // Nothing to poll: a read happens when the row asks for one.
    updateInterval: 0,

    init(viewer) {
      _viewer = viewer || null;
      _enabled = false;
      _busy = false;
      _result = null;
      _error = null;
      _lastReadAt = null;
      _readCameraId = null;
    },

    enable() {
      _enabled = true;
      notify();
    },

    disable() {
      _enabled = false;
      // A read in flight belongs to the layer that asked for it.
      _request?.abort?.();
      _request = null;
      _busy = false;
      _result = null;
      _error = null;
      _readCameraId = null;
      notify();
    },

    getStats() {
      return {
        plates: _result?.plates?.length || 0,
        cameraId: _readCameraId,
        lastReadAt: _lastReadAt,
        busy: _busy,
        error: _error?.code || null,
      };
    },

    getRowControls() {
      const cameraId = selectedCameraId();
      const answer = resultFor(cameraId);
      const lines = plateLines(answer);
      let info = null;
      if (_busy) info = t('Reading the selected camera…');
      else if (!cameraId) info = t('Select a CCTV camera first');
      else if (_error) info = t('Plate reader unavailable');
      else if (answer)
        info = lines.length ? lines.join(' · ') : t('No plate found');
      else info = t('Nothing read yet');
      const cached = isCachedAnswer(answer) ? t('Cached answer') : null;
      return {
        chips: [
          {
            id: 'read',
            label: t('READ PLATE'),
            title: cameraId
              ? t('Read the plates of the selected camera')
              : t('Select a CCTV camera first'),
            disabled: !_enabled || _busy || !cameraId,
            onClick: () => {
              void readSelected();
            },
          },
        ],
        info: [info, cached].filter(Boolean).join(' · '),
        infoTitle: _error
          ? _error.detail || t('The plate reader could not answer')
          : t(
              'Read on the server, from the camera’s own frame; nothing is stored',
            ),
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /** The reader keeps no records to analyse: its answers are not places. */
    getAnalystRecords() {
      return [];
    },

    destroy(viewer = _viewer) {
      this.disable();
      _viewer = null;
    },
  };
}
