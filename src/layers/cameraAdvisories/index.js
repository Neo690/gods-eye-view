import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  ADVISORY_BANDS,
  advisoryHoverLines,
  advisoryListItems,
  failedAdvisorySources,
  normalizeAdvisoryPayload,
  severityColor,
  unqueriedBrands,
} from './records.js';
import { createCameraAdvisoriesSource } from './source.js';

export * from './records.js';
export {
  CAMERA_ADVISORIES_ROUTE,
  createCameraAdvisoriesSource,
} from './source.js';

/** Markers are camera positions, not extents. */
const POINT_PIXELS = 8;
/** How many flagged cameras the row lists by name. */
const LIST_LIMIT = 5;
/** Hover picks are throttled like every other point layer. */
const HOVER_PICK_THROTTLE_MS = 50;

/** English source strings for the severity legend. */
const BAND_LABELS = Object.freeze({
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unscored: 'Unscored',
});

/** A lazy DOM tooltip owned by this layer alone. */
function createTipView({ doc = globalThis.document } = {}) {
  if (!doc) return null;
  let element = null;
  return {
    get visible() {
      return Boolean(element && !element.hidden);
    },
    show(text, pageX, pageY) {
      if (!element) {
        element = doc.createElement('div');
        element.className = 'gev-point-hover-tip';
        element.setAttribute('role', 'tooltip');
        doc.body.appendChild(element);
      }
      element.textContent = text;
      element.style.left = `${pageX}px`;
      element.style.top = `${pageY}px`;
      element.hidden = false;
    },
    hide() {
      if (element) element.hidden = true;
    },
    destroy() {
      element?.remove();
      element = null;
    },
  };
}

/** The drawn identity of one finding: position and the colour it earns. */
function findingsSignature(findings) {
  return findings
    .map(
      (finding) =>
        `${finding.id}:${finding.lat.toFixed(4)}:${finding.lon.toFixed(4)}:${finding.worstSeverity}`,
    )
    .join('|');
}

/**
 * Own one display of published camera advisories.
 *
 * A marker means: this catalogued camera's brand and model appear in a public
 * CISA ICS advisory or NVD CVE record. It never means the camera was touched,
 * scanned, or found vulnerable — the installed firmware is unknown, and the
 * row says so. Cameras whose hardware the catalogue does not name are counted
 * as unjoined, never guessed at.
 *
 * @param {object} [options]
 * @param {{getSnapshot: Function}} [options.source]
 * @param {object} [options.tipView] Test seam: the hover-tip view.
 */
export function createCameraAdvisoriesLayer({
  source = createCameraAdvisoriesSource(),
  tipView = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Camera Advisories requires a snapshot source');
  let _viewer = null;
  let _collection = null;
  let _enabled = false;
  let _request = null;
  let _snapshot = null;
  let _findings = [];
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _retryAt = 0;
  let _failureCount = 0;
  let _tip = tipView;
  let _tipHandler = null;
  let _tipCameraOff = null;
  let _lastPickAt = 0;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  function render() {
    if (!_collection) return;
    const signature = findingsSignature(_findings);
    if (signature === _signature) return;
    _signature = signature;
    _collection.removeAll();
    for (const finding of _findings) {
      const colour = Cesium.Color.fromCssColorString(
        severityColor(finding.worstSeverity),
      );
      _collection.add({
        id: `camera-advisories:${finding.id}`,
        position: Cesium.Cartesian3.fromDegrees(finding.lon, finding.lat),
        pixelSize: POINT_PIXELS,
        color: colour,
        outlineColor: Cesium.Color.fromCssColorString('#08161c').withAlpha(0.9),
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    _viewer?.scene?.requestRender?.();
  }

  function hideTip() {
    const canvas = _viewer?.scene?.canvas;
    if (canvas) canvas.style.cursor = '';
    _tip?.hide();
  }

  /** One throttled pick: the marker under the pointer shows its own advisory. */
  function handleMove(movement) {
    const position = movement?.endPosition;
    if (!_enabled || !position) return hideTip();
    if (!isPointerFree()) return hideTip();
    const now = Date.now();
    if (_tip?.visible && now - _lastPickAt < HOVER_PICK_THROTTLE_MS) return;
    _lastPickAt = now;
    let picked = null;
    try {
      picked = _viewer.scene.pick(
        new Cesium.Cartesian2(position.x, position.y),
      );
    } catch {
      picked = null;
    }
    const finding =
      _findings.find(
        (candidate) => `camera-advisories:${candidate.id}` === picked?.id,
      ) ?? null;
    if (!finding) return hideTip();
    const lines = advisoryHoverLines(finding);
    lines.push(
      t(
        'A published advisory names this product line; the installed firmware was not observed.',
      ),
    );
    if (!_tip && typeof document !== 'undefined') _tip = createTipView();
    const canvas = _viewer?.scene?.canvas;
    const rect = canvas?.getBoundingClientRect?.();
    _tip?.show(
      lines.join('\n'),
      (rect?.left ?? 0) + Number(position.x),
      (rect?.top ?? 0) + Number(position.y),
    );
    if (canvas) canvas.style.cursor = 'pointer';
  }

  function bindHover() {
    const canvas = _viewer?.scene?.canvas;
    if (!canvas) return;
    _tipHandler = new Cesium.ScreenSpaceEventHandler(canvas);
    _tipHandler.setInputAction(
      handleMove,
      Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    );
    _tipCameraOff = _viewer.camera?.moveStart?.addEventListener(hideTip);
  }

  function unbindHover() {
    hideTip();
    try {
      _tipCameraOff?.();
    } catch {
      /* the camera can be gone during teardown */
    }
    _tipCameraOff = null;
    _tipHandler?.destroy?.();
    _tipHandler = null;
  }

  function infoLine(snapshot) {
    const counts = snapshot?.counts ?? {};
    const cameras = snapshot?.cameras ?? {};
    const parts = [
      t(
        '{flagged} cameras with published advisories · {identified} with identified hardware',
        {
          flagged: formatNumber(counts.flagged ?? 0),
          identified: formatNumber(cameras.identified ?? 0),
        },
      ),
      t('{count} matching advisories · {brandOnly} brand-level only', {
        count: formatNumber(counts.advisories ?? 0),
        brandOnly: formatNumber(counts.brandOnlyAdvisories ?? 0),
      }),
      t('firmware not observed · no device contacted'),
    ];
    const unqueried = unqueriedBrands(snapshot);
    if (unqueried.length) {
      parts.push(
        t('{count} brands not queried', {
          count: formatNumber(unqueried.length),
        }),
      );
    }
    if (snapshot?.stale) parts.push(t('stale answer'));
    return parts.join(' · ');
  }

  const layer = {
    id: 'camera-advisories',
    name: 'Camera Advisories',
    icon: '🛡',
    // i18n-ignore: product names
    source: 'CISA ICS · NVD',
    updateInterval: 60 * 60_000,

    init(viewer) {
      if (_viewer)
        throw new Error('Camera Advisories layer is already initialized');
      _viewer = viewer;
      _collection = new Cesium.PointPrimitiveCollection();
      _collection.id = 'camera-advisories';
      _collection.show = false;
      viewer.scene.primitives.add(_collection);
      bindHover();
      console.log('[Data:CameraAdvisories] Initialized');
    },

    enable() {
      _enabled = true;
      if (_collection) _collection.show = true;
      notify();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      _retryAt = 0;
      hideTip();
      if (_collection) _collection.show = false;
      notify();
    },

    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || !_collection || signal?.aborted) return false;
      if (_retryAt && Date.now() < _retryAt) return true;
      _retryAt = 0;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const onAbort = () => request.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const snapshot = await source.getSnapshot(
          {},
          { signal: request.signal },
        );
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _snapshot = snapshot;
        _findings = snapshot.findings;
        render();
        _lastUpdate = Date.now() - Math.max(0, Number(snapshot.ageMs) || 0);
        _lastError = null;
        _failureCount = 0;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _lastError = error?.message || msg('Camera-advisory feed unavailable');
        _failureCount = Math.min(3, _failureCount + 1);
        // A disabled route is a deliberate setting, not a transient failure:
        // retrying cannot change it, so the row explains the switch instead.
        if (error?.retryable !== false && error?.retryableAfterSetup !== true) {
          const delay = Number.isFinite(error?.retryAfterMs)
            ? error.retryAfterMs
            : Math.min(120000, 30000 * 2 ** (_failureCount - 1));
          _retryAt = Date.now() + delay;
        }
        console.warn('[Data:CameraAdvisories] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (_request === request) _request = null;
      }
    },

    getStats() {
      const identified = _snapshot?.cameras?.identified ?? 0;
      return {
        count: _findings.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _snapshot?.stale === true,
        retryInSec: _retryAt
          ? Math.max(0, Math.ceil((_retryAt - Date.now()) / 1000))
          : null,
        ...(identified === 0
          ? {
              emptyHint:
                'The catalogue names no camera brand and model, so no advisory can be joined to a camera. Nothing was scanned.',
            }
          : {}),
      };
    },

    getRowControls() {
      const counts = _snapshot?.counts ?? {};
      const failed = failedAdvisorySources(_snapshot);
      return {
        legend: ADVISORY_BANDS.map((band) => ({
          color: band.color,
          label: t(BAND_LABELS[band.id] ?? 'Unscored'),
          count: counts[band.id] ?? 0,
        })),
        info: _snapshot ? infoLine(_snapshot) : t('No advisory answer yet'),
        infoTitle: _lastError
          ? translateFeedError(_lastError)
          : failed.length
            ? t('Advisory source unavailable: {source}', {
                source: failed.join(', '),
              })
            : undefined,
        list: {
          ordered: true,
          ariaLabel: t('Cameras with published advisories'),
          items: advisoryListItems(_findings, LIST_LIMIT),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /** Snapshot findings as JSON-safe records for the analyst query engine. */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_findings.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return _findings.slice(0, limit).map((finding) => ({
        layerId: 'camera-advisories',
        id: finding.id,
        name: finding.name,
        lat: finding.lat,
        lon: finding.lon,
        brand: finding.brand,
        model: finding.model,
        severity: finding.worstSeverity,
        score: finding.worstScore,
        advisories: finding.matches.map((match) => match.id),
        cves: [...new Set(finding.matches.flatMap((match) => match.cves))],
      }));
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      unbindHover();
      _tip?.destroy?.();
      _tip = null;
      _viewer = null;
      _enabled = false;
      _snapshot = null;
      _findings = [];
      _signature = null;
      _lastUpdate = null;
      _lastError = null;
      _retryAt = 0;
      _failureCount = 0;
      rowControlsListener = null;
      if (_collection) {
        viewer?.scene?.primitives?.remove(_collection);
        _collection = null;
      }
    },
  };
  return layer;
}
