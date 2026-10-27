import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  MAX_POINTS,
  clampViewport,
  normalisePoints,
  pointsSignature,
} from './records.js';

const RAD_TO_DEG = 180 / Math.PI;

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
 * @param {string} config.colour Point colour (CSS).
 * @param {number} [config.pixelSize]
 * @param {number} [config.refreshMs] Interval the data manager re-reads at.
 */
export function createViewportPointsLayer({
  id,
  name,
  icon,
  attribution,
  source,
  sources,
  colour,
  pixelSize = 7,
  refreshMs = 120000,
  requiresKeyId,
  emptyHint,
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

  const bounds = () => clampViewport(cameraBounds(_viewer));

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
    // Only position and identity change what is drawn.
    const signature = pointsSignature(_points);
    if (signature === _signature) return;
    _signature = signature;
    _collection.removeAll();
    const color = Cesium.Color.fromCssColorString(colour);
    for (const point of _points) {
      _collection.add({
        id: `${id}:${point.id}`,
        position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat),
        pixelSize,
        color,
        outlineColor: color.withAlpha(0.25),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    _viewer?.scene?.requestRender?.();
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
      clearTimeout(_cameraTimer);
      clearTimeout(_retryTimer);
      _cameraTimer = null;
      _retryTimer = null;
      _points = [];
      _signature = null;
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
      const chips = choices.map((choice) => ({
        label: choice.label,
        active: choice.id === _activeSource,
        onClick: () => {
          if (choice.id === _activeSource) return;
          _activeSource = choice.id;
          _retryAt = 0;
          _failureCount = 0;
          if (_manager) void _manager.refreshLayer(id);
          else void layer.update();
        },
      }));
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
          t('{count} in view · {source} · {attribution}', {
            count: formatNumber(_points.length),
            source:
              choices.find((choice) => choice.id === _activeSource)?.label ??
              attribution,
            attribution,
          }) +
          (_truncated
            ? ` · ${t('capped at {limit}', { limit: MAX_POINTS })}`
            : '') +
          errorLine,
        infoTitle:
          (_coverage?.clamped
            ? t(
                'The view was wider than one request: the nearest {span}° around the centre is shown.',
                { span: 6 },
              ) + ' '
            : '') +
          t(
            'Positions come from the provider, not from measurements taken here. Zoom in for a denser answer.',
          ),
        legend: [],
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
