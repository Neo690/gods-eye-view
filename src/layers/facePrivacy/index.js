/**
 * Face Privacy: read the people of the CCTV camera the map has selected.
 *
 * This layer draws nothing on the globe. It is a row with one action —
 * analyse the selected camera now — and the faces it found, because people
 * are not places either: a face's box only means anything next to the frame
 * it came from, and putting it on the globe would publish where it was read.
 *
 * The banner is a blur, not a label. The detector answers boxes; the overlay
 * blurs exactly those boxes over the panel's picture, so a screen can be
 * shared with the audience without being shared with the road. No name is
 * ever attached to a face: the server keeps no roster for this route —
 * analysis only — and identity is an enrollment decision made elsewhere,
 * with consent, not a thing this row claims by looking.
 *
 * Nothing here is persisted. The boxes live in this closure until the next
 * read, are never written to layer state, and are gone when the tab closes
 * or the layer is turned off; the server keeps its own copy for a few
 * seconds only.
 *
 * The read is on demand rather than on a timer: a timer would make the
 * panel a watcher of whatever camera happened to be selected, which is not
 * what switching a layer on should mean.
 * @module layers/facePrivacy
 */
import { t } from '../../i18n/index.js';
import { FACE_LAYER_ID, faceCount, isCachedAnswer } from './model.js';
import {
  PEOPLE_BASIS,
  PEOPLE_LIMIT_NOTE,
  countPeople,
  peopleLabel,
} from './people.js';

export { FACE_LAYER_ID } from './model.js';
export { createFaceAnalysisSource, FaceAnalysisError } from './sources.js';
export {
  PEOPLE_BASIS,
  PEOPLE_LIMIT_NOTE,
  countPeople,
  peopleLabel,
  peopleSummary,
} from './people.js';

/**
 * @param {object} options
 * @param {{read: Function}} options.source Server reader (see `./sources.js`).
 * @param {{getParams?: Function}} [options.camera] The CCTV layer, asked for
 *   the camera it currently has selected, and subscribed to so the blur goes
 *   away when the selection moves.
 * @param {Function} [options.now] Clock, replaced by the tests.
 * @param {{show: Function, clear: Function, destroy?: Function}} [options.overlay]
 *   Where the face blur is drawn (see `./overlay.js`). Absent in a build
 *   without the panel, and in most tests: the layer then answers in the row
 *   only, which is what it always did.
 */
export function createFaceLayer({
  source,
  camera,
  now = () => Date.now(),
  overlay = null,
} = {}) {
  if (typeof source?.read !== 'function')
    throw new TypeError('Face layer requires a read source');

  let _viewer = null;
  let _enabled = false;
  let _busy = false;
  let _request = null;
  let _result = null;
  let _error = null;
  let _lastReadAt = null;
  let _readCameraId = null;
  let _cameraUnsubscribe = null;
  let _overlayShown = false;
  let _blurring = false;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  /** Take the blur off the picture, once: a clear with nothing drawn is noise. */
  const clearOverlay = () => {
    if (!_overlayShown) return;
    _overlayShown = false;
    _blurring = false;
    overlay?.clear?.();
  };

  /**
   * Blur the faces of one answer over the frame it came from.
   *
   * An answer with no face in it clears instead: a read that finds nobody
   * must not leave the previous read's blur pointing at an empty street.
   */
  const showOverlay = (payload, cameraId) => {
    const faces = Array.isArray(payload?.faces) ? payload.faces : [];
    if (!faces.length) {
      clearOverlay();
      return;
    }
    try {
      overlay?.show?.({ cameraId, frame: payload?.frame, faces });
      _overlayShown = true;
      _blurring = true;
    } catch (error) {
      // A drawing failure must not turn a good read into a failed one.
      console.warn('[Data:FacePrivacy] overlay failed:', error);
      clearOverlay();
    }
  };

  /**
   * Forget the blur as soon as it stops describing what is on screen.
   *
   * The panel follows the CCTV layer's selected camera, and a read is tied
   * to the camera it was asked about: a blur on the next camera's picture
   * would hide nobody and point at nothing.
   */
  const watchCamera = () => {
    if (_cameraUnsubscribe || typeof camera?.subscribe !== 'function') return;
    _cameraUnsubscribe = camera.subscribe((state) => {
      if (state?.activeCameraId !== _readCameraId) clearOverlay();
    });
  };

  const unwatchCamera = () => {
    _cameraUnsubscribe?.();
    _cameraUnsubscribe = null;
  };

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
  async function readSelected({ blur = true } = {}) {
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
      // A headcount answers a question about the picture; it must not change
      // the picture. Only the blur action paints the overlay.
      if (blur) showOverlay(payload, cameraId);
      console.log(
        `[Data:FacePrivacy] ${cameraId}: ${payload.faces.length} face(s)`,
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
      clearOverlay();
      return null;
    } finally {
      _request = null;
      _busy = false;
      notify();
    }
  }

  return {
    id: FACE_LAYER_ID,
    name: 'Face Privacy',
    icon: '🙂',
    source: 'ONNX · SCRFD detector, server-side',
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
      unwatchCamera();
      clearOverlay();
    },

    enable() {
      _enabled = true;
      watchCamera();
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
      unwatchCamera();
      clearOverlay();
      notify();
    },

    /**
     * Nothing to fetch on a tick: a read happens when the row asks for one.
     *
     * The manager still calls this as the layer turns on, and reads `false`
     * as a refused transition and switches the layer back off — which is
     * exactly what a missing method did to the plate reader: `update is not
     * a function`, the switch snapped back to off, and the row looked
     * broken. There is nothing to draw and nothing to refuse, so it
     * resolves true.
     */
    async update() {
      return true;
    },

    getStats() {
      return {
        faces: _result ? faceCount(_result) : 0,
        people: countPeople(_result),
        cameraId: _readCameraId,
        lastReadAt: _lastReadAt,
        busy: _busy,
        blurring: _blurring,
        error: _error?.code || null,
      };
    },

    getRowControls() {
      const cameraId = selectedCameraId();
      const answer = resultFor(cameraId);
      const count = faceCount(answer);
      let info = null;
      if (_busy) info = t('Reading the selected camera…');
      else if (!cameraId) info = t('Select a CCTV camera first');
      else if (_error) info = t('Face analysis unavailable');
      else if (answer) info = peopleLabel(count);
      else info = t('Nothing analysed yet');
      const cached = isCachedAnswer(answer) && t('Cached answer');
      return {
        chips: [
          {
            id: 'read',
            label: _blurring ? t('STOP BLUR') : t('BLUR FACES'),
            title: cameraId
              ? _blurring
                ? t('Take the blur off the picture')
                : t('Blur every face of the selected camera')
              : t('Select a CCTV camera first'),
            disabled: !_enabled || _busy || !cameraId,
            onClick: () => {
              if (_blurring) {
                clearOverlay();
                notify();
                return;
              }
              void readSelected();
            },
          },
          {
            // A headcount, not a blur: the operator can ask how many people
            // are on the frame without the picture changing under them.
            id: 'count',
            label: t('COUNT PEOPLE'),
            title: cameraId
              ? t('Count the people visible in the selected camera')
              : t('Select a CCTV camera first'),
            disabled: !_enabled || _busy || !cameraId,
            onClick: () => {
              void readSelected({ blur: false });
            },
          },
        ],
        info: [info, cached].filter(Boolean).join(' · '),
        infoTitle: _error
          ? _error.detail || t('Face analysis could not answer')
          : `${t('Analysed on the server, from the camera’s own frame; identities are never matched here')} ${t(PEOPLE_LIMIT_NOTE)}`,
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Headcount for the selected camera, as data another surface can use
     * (voice, a panel badge) without re-reading the frame.
     *
     * The count belongs to the camera the answer came from: switching cameras
     * reports zero rather than the previous camera's people.
     *
     * @returns {{cameraId: string|null, count: number, at: number|null,
     *   basis: string, busy: boolean, error: string|null}}
     */
    getPersonCount() {
      const cameraId = selectedCameraId();
      const answer = resultFor(cameraId);
      return {
        cameraId,
        count: countPeople(answer),
        at: answer ? _lastReadAt : null,
        basis: PEOPLE_BASIS,
        busy: _busy,
        error: _error?.code || null,
      };
    },

    /** The layer keeps no records to analyse: people are not places. */
    getAnalystRecords() {
      return [];
    },

    destroy(viewer = _viewer) {
      this.disable();
      overlay?.destroy?.();
      _viewer = null;
    },
  };
}
