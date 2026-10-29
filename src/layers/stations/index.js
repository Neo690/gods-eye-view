import * as Cesium from 'cesium';
import {
  BOARD_REFRESH_MS,
  LAYER_ID,
  POLL_MS,
  STATION_COLOR,
  STATION_ENTITY_PREFIX,
  STATION_OVERLAY_SOURCE_ID,
  STATION_PIXEL_SIZE,
  STATION_SELECTED_COLOR,
  STATION_SELECTED_OVERLAY_SOURCE_ID,
  STATION_SELECTED_OVERLAY_SOURCE_OPTIONS,
  STATION_SELECTED_PIXEL_SIZE,
  LABEL_COLLISION_CAPACITY,
  SERVER_WAKE_HINT_MS,
  buildStationSelectionCopy,
  clampViewport,
  createStationOverlayEntry,
  createStationSelectedOverlayEntry,
  selectStationCohort,
  shouldRefetch,
  stationIdFromPick,
  stationLoadingLabel,
} from './policy.js';
import { createOverpassStationSource } from './source.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { t } from '../../i18n/index.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';

export * from './policy.js';
export * from './records.js';
export { createOverpassStationSource } from './source.js';

// A portable package (no i18n): the error stays English data and the layer
// panel shows it translated.
const msg = (text) => text;

/**
 * Convert the camera's view rectangle into degrees.
 *
 * A camera pointed at the horizon, or through the planet, has no meaningful
 * rectangle; null tells the caller to keep the stations it already has rather
 * than refetch a box that does not exist.
 *
 * @param {object} viewer Cesium viewer.
 * @returns {{south:number, west:number, north:number, east:number}|null}
 */
export function cameraViewport(viewer) {
  const rectangle = viewer?.camera?.computeViewRectangle(
    viewer.scene.globe.ellipsoid,
  );
  if (!rectangle) return null;
  const south = Cesium.Math.toDegrees(rectangle.south);
  const north = Cesium.Math.toDegrees(rectangle.north);
  const west = Cesium.Math.toDegrees(rectangle.west);
  const east = Cesium.Math.toDegrees(rectangle.east);
  if (![south, north, west, east].every(Number.isFinite)) return null;
  return { south, west, north, east };
}

/** Own one railway-station display and its refresh lifecycle. */
export function createRailwayStationsLayer({
  source,
  overlayHost,
  departures,
} = {}) {
  if (typeof source?.getSnapshot !== 'function') {
    source = createOverpassStationSource();
  }
  if (!overlayHost) throw new TypeError('Stations require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _loadedBox = null;
  /** When the in-flight station request began, or null when none is running. */
  let _requestStartedAt = null;
  /** Repaint armed for the moment a wait becomes long enough to name. */
  let _wakeTimer = null;
  /** The manager, only so a long wait can repaint its own row (see below). */
  let _dataManager = null;
  /** Station records of the last load, keyed by OSM id — what a click resolves. */
  let _recordsById = new Map();
  let _clickHandler = null;
  let _selectedKey = null;
  let _selectedEntity = null;
  /** In-flight board read for the selected station, if any. */
  let _boardRequest = null;
  /** Pending refresh of the open board, if any. */
  let _boardTimer = null;
  /** Last board fetched, keyed by station id, so a re-click does not refetch. */
  const _boardCache = new Map();

  /**
   * Repaint the layer row once the request has stood long enough that the wait
   * itself is the news (a hosted server cold start). Nothing else would redraw
   * it before the request settles: the manager publishes a status change when
   * the refresh begins and another when it ends, not in between.
   */
  function scheduleWakeHint() {
    clearWakeHint();
    if (!_dataManager) return;
    _wakeTimer = setTimeout(() => {
      _wakeTimer = null;
      _dataManager?.refreshLayerStats?.();
    }, SERVER_WAKE_HINT_MS);
    // A pending repaint must not hold a test process (or a closing tab) open.
    _wakeTimer?.unref?.();
  }

  function clearWakeHint() {
    if (!_wakeTimer) return;
    clearTimeout(_wakeTimer);
    _wakeTimer = null;
  }

  /** Cancel a scheduled board refresh; the card is closing or moving. */
  function stopBoardRefresh() {
    if (!_boardTimer) return;
    clearTimeout(_boardTimer);
    _boardTimer = null;
  }

  /** Drop the selected card and its highlight marker. */
  function clearSelection() {
    stopBoardRefresh();
    _boardRequest?.abort();
    _boardRequest = null;
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    _selectedKey = null;
    overlayHost.clearSource(STATION_SELECTED_OVERLAY_SOURCE_ID);
  }

  /** Repaint the selected station's card, optionally with a live board. */
  function paintSelection(record, position, board) {
    const entry = createStationSelectedOverlayEntry(
      record.id,
      position,
      buildStationSelectionCopy(record, t, board),
    );
    if (!entry) return;
    overlayHost.setEntries(STATION_SELECTED_OVERLAY_SOURCE_ID, [entry], {
      ...STATION_SELECTED_OVERLAY_SOURCE_OPTIONS,
    });
  }

  /**
   * Ask for the station's live departures and repaint the card in place.
   *
   * The mapped card is painted first and never waits on the network: a station
   * whose operator publishes nothing keeps a useful card, and a board that
   * arrives late is dropped when the selection has moved on.
   */
  async function loadDepartures(stationId, record, position) {
    if (typeof departures?.getBoard !== 'function') return;
    const controller = new AbortController();
    _boardRequest?.abort();
    _boardRequest = controller;
    try {
      const board = await departures.getBoard(
        { lat: record.lat, lon: record.lon },
        { signal: controller.signal },
      );
      if (controller.signal.aborted || _selectedKey !== stationId) return;
      if (!board) return;
      _boardCache.set(stationId, board);
      paintSelection(record, position, board);
    } catch (error) {
      if (controller.signal.aborted) return;
      // A board is a bonus on a mapped card, never a failure of it.
      console.warn('[Data:Stations] Departures unavailable:', error?.message);
    } finally {
      if (_boardRequest === controller) _boardRequest = null;
      // Keep the open board live: the same station is asked again while its
      // card is on screen, and the schedule dies with the selection.
      if (!controller.signal.aborted && _selectedKey === stationId) {
        stopBoardRefresh();
        _boardTimer = setTimeout(() => {
          _boardTimer = null;
          if (_selectedKey !== stationId || !_enabled) return;
          void loadDepartures(stationId, record, position);
        }, BOARD_REFRESH_MS);
        // A pending refresh must not hold a test process (or a closing tab) open.
        _boardTimer?.unref?.();
      }
    }
  }

  /** Highlight one station and show what the map records about it. */
  function selectStation(stationId) {
    const record = _recordsById.get(stationId);
    if (!record || !_viewer) return;
    clearSelection();
    const position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
    _selectedKey = stationId;
    _selectedEntity = _viewer.entities.add({
      position,
      point: {
        pixelSize: STATION_SELECTED_PIXEL_SIZE,
        color: Cesium.Color.fromCssColorString(STATION_SELECTED_COLOR),
        outlineColor: Cesium.Color.fromCssColorString(STATION_COLOR),
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    paintSelection(record, position, _boardCache.get(stationId) || null);
    void loadDepartures(stationId, record, position);
  }

  function onKeyDown(event) {
    if (event?.key === 'Escape' && _selectedKey) clearSelection();
  }

  /**
   * Install the click handler. Idempotent: enabling twice keeps one handler.
   * A click on another layer's marker is left alone rather than read as empty
   * space, so selecting a station never cancels someone else's selection.
   */
  function installClickHandler(viewer) {
    if (_clickHandler) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      // Clicking the highlight itself is not a request to deselect.
      if (_selectedEntity && picked?.id === _selectedEntity) return;
      const pickedId = resolvePickId(picked);
      if (pickedId && isOwnedByOtherLayer(LAYER_ID, pickedId)) return;
      const stationId = stationIdFromPick(pickedId);
      if (stationId && _recordsById.has(stationId)) {
        selectStation(stationId);
        return;
      }
      // Empty space deselects, the way every other selectable layer behaves.
      if (_selectedKey) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    document.addEventListener('keydown', onKeyDown);
  }

  function removeInteraction(viewer) {
    clearSelection();
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    document.removeEventListener('keydown', onKeyDown);
    unregisterPickOwner(LAYER_ID);
    void viewer;
  }

  const layer = {
    id: LAYER_ID,
    name: 'Railway Stations',
    icon: '🚉',
    source: 'OpenStreetMap',
    updateInterval: POLL_MS,

    init(viewer) {
      if (_viewer) throw new Error('Station layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _loadedBox = null;
      _requestStartedAt = null;
      _recordsById = new Map();
      _clickHandler = null;
      _selectedKey = null;
      _selectedEntity = null;
      overlayHost.setVisible(STATION_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(STATION_SELECTED_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Stations] Initialized');
    },

    enable(viewer = _viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(STATION_OVERLAY_SOURCE_ID, true);
      overlayHost.setVisible(STATION_SELECTED_OVERLAY_SOURCE_ID, true);
      if (viewer) installClickHandler(viewer);
      registerPickOwner(LAYER_ID, (pickedId) =>
        _recordsById.has(stationIdFromPick(pickedId) || ''),
      );
    },

    disable(viewer = _viewer) {
      _request?.abort();
      _request = null;
      clearWakeHint();
      _requestStartedAt = null;
      stopBoardRefresh();
      _boardRequest?.abort();
      _boardRequest = null;
      _enabled = false;
      removeInteraction(viewer);
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(STATION_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(STATION_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(STATION_SELECTED_OVERLAY_SOURCE_ID, false);
      _recordsById = new Map();
    },

    async update(viewer = _viewer) {
      if (!_enabled || !_dataSource) return false;
      const view = clampViewport(cameraViewport(viewer));
      // A parked camera over the same city asks nothing: stations do not move,
      // and a mirror should not be polled for an answer already on screen.
      if (!shouldRefetch(_loadedBox, view, _count > 0)) return true;
      if (!view) return false;

      _request?.abort();
      const request = new AbortController();
      _request = request;
      _requestStartedAt = Date.now();
      scheduleWakeHint();
      try {
        const snapshot = await source.getSnapshot(view, {
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const entities = [];
        const labels = [];
        const byId = new Map();
        for (const station of snapshot.records) {
          const position = Cesium.Cartesian3.fromDegrees(
            station.lon,
            station.lat,
          );
          const entityId = `${STATION_ENTITY_PREFIX}${station.id}`;
          entities.push(
            new Cesium.Entity({
              id: entityId,
              position,
              point: {
                pixelSize: STATION_PIXEL_SIZE,
                color:
                  Cesium.Color.fromCssColorString(STATION_COLOR).withAlpha(0.9),
                outlineColor: Cesium.Color.WHITE.withAlpha(0.75),
                outlineWidth: 1,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
              properties: {
                name: station.name,
                operator: station.operator,
                network: station.network,
                usage: station.usage,
                platforms: station.platforms,
                osmId: station.id,
              },
            }),
          );
          byId.set(station.id, station);
          labels.push(
            createStationOverlayEntry({
              id: station.id,
              position,
              name: station.name,
              usage: station.usage,
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of entities) _dataSource.entities.add(entity);
        _recordsById = byId;
        // A selected station that the new view no longer holds cannot keep a
        // card pointing at a marker that is gone.
        if (_selectedKey && !byId.has(_selectedKey)) clearSelection();
        if (_enabled) {
          overlayHost.setEntries(
            STATION_OVERLAY_SOURCE_ID,
            selectStationCohort(labels),
            {
              cohortLimit: labels.length,
              collisionCapacity: LABEL_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _count = snapshot.records.length;
        _loadedBox = view;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:Stations] Updated: ${_count} stations${snapshot.saturated ? ' (limited)' : ''}`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Stations] Fetch error:', e);
        _lastError = e?.message || msg('Station source unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
        // The settle is reported by the manager's own status publish; the row
        // must simply stop claiming a wait that is over.
        clearWakeHint();
        _requestStartedAt = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      clearWakeHint();
      _requestStartedAt = null;
      stopBoardRefresh();
      _boardRequest?.abort();
      _boardRequest = null;
      _enabled = false;
      removeInteraction(viewer);
      overlayHost.clearSource(STATION_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(STATION_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(STATION_SELECTED_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _dataManager = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _loadedBox = null;
      _recordsById = new Map();
    },

    /**
     * The manager calls this on every layer, so a long first load can repaint
     * its own row (see scheduleWakeHint). Null-safe: the layer works alone.
     */
    attachDataManager(manager) {
      _dataManager = manager || null;
    },

    getStats() {
      const elapsed =
        _requestStartedAt === null ? null : Date.now() - _requestStartedAt;
      // Only a first answer is waited for: once stations are drawn, a later
      // refresh keeps the count and age on screen instead of flapping to
      // "connecting" every poll.
      const loading = elapsed !== null && _count === 0;
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        loading,
        loadingLabel: loading ? stationLoadingLabel(elapsed) : '',
      };
    },
  };
  return layer;
}
