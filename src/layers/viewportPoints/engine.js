import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { formatNumber, msg, t, translateKnown } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  MAX_POINTS,
  MAX_SPAN_DEG,
  clampViewport,
  normalisePoints,
  pointsSignature,
} from './records.js';

const RAD_TO_DEG = 180 / Math.PI;

/** How often a hovered marker is re-picked while the pointer sweeps over it. */
const HOVER_PICK_THROTTLE_MS = 50;

/**
 * The hover-tip element the point layers that opt in share. Created lazily on
 * the first hover and removed on destroy, so a layer never owns a DOM node
 * it does not show.
 */
function defaultPointTipView({ doc = globalThis.document } = {}) {
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

/**
 * Read the current view as degrees. Returns null while the camera is still
 * settling, so startup never spends the first request on a default camera.
 * @param {object} viewer
 * @returns {{west:number,south:number,east:number,north:number}|null}
 */
export function cameraBounds(viewer) {
  const ellipsoid = viewer?.scene?.globe?.ellipsoid;
  const rectangle = viewer?.camera?.computeViewRectangle?.(ellipsoid);
  if (!rectangle) return null;
  return {
    west: Cesium.Math.toDegrees(rectangle.west),
    south: Cesium.Math.toDegrees(rectangle.south),
    east: Cesium.Math.toDegrees(rectangle.east),
    north: Cesium.Math.toDegrees(rectangle.north),
  };
}

/**
 * One viewport-bounded point layer: connected objects, radio sites. Both ask
 * a provider for what is inside the current view, draw what came back, and
 * never pretend a capped view is a world snapshot.
 *
 * @param {object} config
 * @param {string} config.id Layer id (also the panel and share-token key).
 * @param {string} config.name
 * @param {string} config.icon
 * @param {string} config.attribution Shown in the row info; licences require it.
 * @param {{getSnapshot: Function}} config.source Browser-side source.
 * @param {{id:string,label:string}[]} config.sources Provider choices.
 * @param {string} config.colour Point colour (CSS), when all points match.
 * @param {(point:object)=>string} [config.pointColour] Colour one point from
 *   its own row; its input is kept in the drawn signature, so an updated
 *   status re-renders instead of being skipped as a no-op draw.
 * @param {{label:string,color:string}[]} [config.legend] Static row legend.
 * @param {number} [config.pixelSize]
 * @param {number} [config.refreshMs] Interval the data manager re-reads at.
 * @param {number} [config.maxSpanDeg] Widest view one request may cover.
 * @param {(context: {refresh: () => void}) => {chips?: Array<object>, detail?: string}}
 *   [config.extras] Row controls a local-data layer owns itself (importing a
 *   file, clearing it). Called on every panel refresh, so it must only read.
 * @param {{show:(text:string,x:number,y:number)=>void,hide:()=>void,
 *   destroy:()=>void}|null} [config.tipView] Test seam: the hover-tip view.
 *   Built lazily from the DOM when unset.
 * @param {Function} [config.pointerHandlerFactory] Test seam: how the Cesium
 *   pointer handler is built for hover tips.
 */
export function createViewportPointsLayer({
  id,
  name,
  icon,
  attribution,
  source,
  sources,
  colour,
  pointColour,
  legend,
  pixelSize = 7,
  refreshMs = 120000,
  maxSpanDeg = MAX_SPAN_DEG,
  requiresKeyId,
  emptyHint,
  extras,
  hoverTip = null,
  tipView = null,
  pointerHandlerFactory = undefined,
}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError(`${name} layer requires a snapshot source`);
  const choices = Array.isArray(sources) && sources.length ? sources : [];
  let _viewer = null;
  let _collection = null;
  let _enabled = false;
  let _request = null;
  let _retryTimer = null;
  let _retryAt = 0;
  let _failureCount = 0;
  let _lastRequestAt = 0;
  let _cameraTimer = null;
  let _points = [];
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _coverage = null;
  let _truncated = false;
  let _activeSource = choices[0]?.id ?? null;
  let _manager = null;

  // Hover-tip state. Bound only when the layer supplies hoverTip; dormant
  // layers (cellTowers, iotSensors, privateWifi) never allocate it.
  let _tipView = tipView ?? (hoverTip ? tipView : undefined);
  let _tipHandler = null;
  let _tipCameraOff = null;
  let _hoverLastPickAt = 0;

  const spanLimit =
    Number.isFinite(Number(maxSpanDeg)) && Number(maxSpanDeg) > 0
      ? Number(maxSpanDeg)
      : MAX_SPAN_DEG;
  const bounds = () => clampViewport(cameraBounds(_viewer), spanLimit);

  function scheduleRefresh() {
    if (!_enabled || !_collection) return;
    clearTimeout(_cameraTimer);
    // Bound a drag or a follow camera to one request every few seconds and
    // let the last position win.
    const wait = Math.max(1200, 4000 - (Date.now() - _lastRequestAt));
    _cameraTimer = setTimeout(() => {
      _cameraTimer = null;
      if (!_enabled || _request) return;
      if (_manager) void _manager.refreshLayer(id);
      else void layer.update();
    }, wait);
  }

  function scheduleRetry() {
    clearTimeout(_retryTimer);
    _retryTimer = null;
    if (!_enabled || !_retryAt) return;
    _retryTimer = setTimeout(
      () => {
        _retryTimer = null;
        if (_manager) void _manager.refreshLayer(id);
        else void layer.update();
      },
      Math.min(2147483647, Math.max(0, _retryAt - Date.now())),
    );
    _retryTimer?.unref?.();
  }

  function render() {
    // Only position, identity and (when a row decides its own colour) the
    // coloured field change what is drawn.
    const signature = pointsSignature(
      _points,
      pointColour ? (point) => pointColour(point) : null,
    );
    if (signature === _signature) return;
    _signature = signature;
    _collection.removeAll();
    const baseColor = Cesium.Color.fromCssColorString(colour);
    for (const point of _points) {
      const drawn = pointColour
        ? Cesium.Color.fromCssColorString(pointColour(point) || colour)
        : baseColor;
      _collection.add({
        id: `${id}:${point.id}`,
        position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
        pixelSize,
        color: drawn,
        outlineColor: drawn.withAlpha(0.25),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    _viewer?.scene?.requestRender?.();
  }

  function hidePointerTip() {
    const canvas = _viewer?.scene?.canvas;
    if (canvas) canvas.style.cursor = '';
    _tipView?.hide();
  }

  /**
   * One throttled MOUSE_MOVE pick: the marker under the pointer shows its own
   * tip (the layer's hoverTip builds the text); anything else casts nothing.
   * A tool that claimed the pointer (inputOwnership) gets no hover at all.
   */
  function handleHoverMove(movement) {
    const position = movement?.endPosition;
    if (!_enabled || !position) return hidePointerTip();
    if (!isPointerFree()) return hidePointerTip();
    const canvas = _viewer?.scene?.canvas;
    const rect = canvas?.getBoundingClientRect?.();
    const pageX = (rect?.left ?? 0) + Number(position.x) || 0;
    const pageY = (rect?.top ?? 0) + Number(position.y) || 0;
    const now = Date.now();
    if (_tipView?.visible && now - _hoverLastPickAt < HOVER_PICK_THROTTLE_MS)
      return;
    _hoverLastPickAt = now;
    let picked = null;
    try {
      picked = _viewer.scene.pick(
        new Cesium.Cartesian2(position.x, position.y),
      );
    } catch {
      picked = null;
    }
    const point =
      _points.find((candidate) => `${id}:${candidate.id}` === picked?.id) ||
      null;
    if (!point || !hoverTip) {
      hidePointerTip();
      return;
    }
    const text = hoverTip(point);
    if (!text) return hidePointerTip();
    if (!_tipView && typeof document !== 'undefined')
      _tipView = defaultPointTipView();
    _tipView?.show(text, pageX, pageY);
    if (canvas) canvas.style.cursor = 'pointer';
  }

  /**
   * A camera drag sweeps the pointer over markers that mean nothing while it
   * moves: hide the tip at moveStart instead of flashing rows under a drag.
   */
  function bindHoverTip() {
    if (!hoverTip) return;
    const canvas = _viewer?.scene?.canvas;
    if (!canvas) return;
    const factory =
      pointerHandlerFactory ??
      ((target) => new Cesium.ScreenSpaceEventHandler(target));
    _tipHandler = factory(canvas);
    _tipHandler.setInputAction(
      handleHoverMove,
      Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    );
    _tipCameraOff = _viewer.camera?.moveStart?.addEventListener(hidePointerTip);
  }

  function unbindHoverTip() {
    hidePointerTip();
    if (_tipCameraOff) {
      try {
        _tipCameraOff();
      } catch {
        // The camera can already be gone during teardown.
      }
      _tipCameraOff = null;
    }
    if (_tipHandler) {
      _tipHandler.destroy?.();
      _tipHandler = null;
    }
  }

  const layer = {
    id,
    name,
    icon,
    source: attribution,
    updateInterval: refreshMs,
    ...(requiresKeyId ? { requiresKeyId } : {}),

    attachDataManager(manager) {
      _manager = manager;
    },

    init(viewer) {
      if (_viewer) throw new Error(`${name} layer is already initialized`);
      _viewer = viewer;
      _collection = new Cesium.PointPrimitiveCollection();
      _collection.id = id;
      _collection.show = false;
      viewer.scene.primitives.add(_collection);
      viewer.camera?.moveEnd?.addEventListener(scheduleRefresh);
      viewer.camera?.changed?.addEventListener(scheduleRefresh);
      bindHoverTip();
    },

    enable() {
      _enabled = true;
      if (_collection) _collection.show = true;
    },

    disable() {
      clearTimeout(_cameraTimer);
      clearTimeout(_retryTimer);
      _cameraTimer = null;
      _retryTimer = null;
      _request?.abort();
      _request = null;
      _enabled = false;
      hidePointerTip();
      if (_collection) _collection.show = false;
    },

    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || !_collection || signal?.aborted) return false;
      if (_retryAt && Date.now() < _retryAt) {
        scheduleRetry();
        return true;
      }
      _retryAt = 0;
      const view = bounds();
      // A settling camera is not a failure; the next interval or camera move
      // retries. Returning false here would make the manager reject enabling.
      if (!view.bounds) return true;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const onAbort = () => request.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      _lastRequestAt = Date.now();
      _coverage = {
        ...view.bounds,
        clamped: view.clamped,
      };
      try {
        const snapshot = await source.getSnapshot(
          { bounds: view.bounds, provider: _activeSource },
          { signal: request.signal },
        );
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _points = normalisePoints(snapshot.rows, MAX_POINTS);
        _truncated =
          snapshot.truncated === true || snapshot.rows.length > MAX_POINTS;
        render();
        _lastUpdate = Date.now() - (Number(snapshot.ageMs) || 0);
        _stale = snapshot.stale === true;
        _lastError = null;
        _failureCount = 0;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn(`[Data:${id}] Fetch error:`, e);
        _lastError = e?.message || msg(`${name} source unavailable`);
        _points = [];
        render();
        if (e?.retryable === false) return true;
        _failureCount = Math.min(3, _failureCount + 1);
        const delay =
          Number.isFinite(e?.retryAfterMs) && e.retryAfterMs > 0
            ? e.retryAfterMs
            : Math.min(120000, 30000 * 2 ** (_failureCount - 1));
        _retryAt = Date.now() + delay;
        scheduleRetry();
        return true;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (_request === request) _request = null;
        scheduleRefresh();
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      unbindHoverTip();
      clearTimeout(_cameraTimer);
      clearTimeout(_retryTimer);
      _cameraTimer = null;
      _retryTimer = null;
      _points = [];
      _signature = null;
      _tipView?.destroy?.();
      _tipView = null;
      if (_collection) {
        viewer?.scene?.primitives?.remove(_collection);
        _collection = null;
      }
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _coverage = null;
      _retryAt = 0;
      _failureCount = 0;
      _manager = null;
    },

    /** Plain snapshot for the analyst query engine and the share registry. */
    getAnalystRecords(maxCount = MAX_POINTS) {
      if (!_collection?.show) return [];
      return _points.slice(0, maxCount).map((point) => ({
        id: point.id,
        label: point.label,
        lat: point.lat,
        lon: point.lon,
        meta: point.meta,
      }));
    },

    getRowControls() {
      // One reload path for provider switches and for a layer that supplies
      // its own controls: both mean "the data changed under the last read".
      const reload = () => {
        _retryAt = 0;
        _failureCount = 0;
        if (_manager) void _manager.refreshLayer(id);
        else void layer.update();
      };
      const chips = choices.map((choice) => ({
        label: choice.label,
        active: choice.id === _activeSource,
        onClick: () => {
          if (choice.id === _activeSource) return;
          _activeSource = choice.id;
          reload();
        },
      }));
      const extra =
        typeof extras === 'function' ? extras({ refresh: reload }) : null;
      if (Array.isArray(extra?.chips)) chips.push(...extra.chips);
      const errorLine = _lastError
        ? ` · ${translateFeedError(_lastError)}`
        : _retryAt
          ? ` · ${t('Retrying automatically at {time} UTC', {
              time: new Date(_retryAt).toISOString().slice(11, 19),
            })}`
          : '';
      return {
        chips,
        info:
          // Without provider choices the attribution IS the source; naming it
          // twice would read like a duplicate, not a citation.
          (choices.length
            ? t('{count} in view · {source} · {attribution}', {
                count: formatNumber(_points.length),
                source:
                  choices.find((choice) => choice.id === _activeSource)
                    ?.label ?? attribution,
                // A local layer's attribution is UI copy ("Your WiGLE
                // export"); a provider citation is a product name and stays
                // as written, which is exactly what translateKnown decides.
                attribution: translateKnown(attribution),
              })
            : t('{count} in view · {attribution}', {
                count: formatNumber(_points.length),
                attribution: translateKnown(attribution),
              })) +
          (_truncated
            ? ` · ${t('capped at {limit}', { limit: MAX_POINTS })}`
            : '') +
          (extra?.detail ? ` · ${extra.detail}` : '') +
          errorLine,
        infoTitle:
          (_coverage?.clamped
            ? t(
                'The view was wider than one request: the nearest {span}° around the centre is shown.',
                { span: spanLimit },
              ) + ' '
            : '') +
          t(
            'Positions come from the provider, not from measurements taken here. Zoom in for a denser answer.',
          ),
        legend: Array.isArray(legend) ? legend : [],
      };
    },

    getStats() {
      return {
        count: _points.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        retryInSec: _retryAt
          ? Math.max(0, Math.ceil((_retryAt - Date.now()) / 1000))
          : null,
        stale: _stale,
        coverage: _coverage,
        provider: _activeSource,
        truncated: _truncated,
        ...(emptyHint ? { emptyHint } : {}),
      };
    },
  };
  return layer;
}
