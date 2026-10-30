/**
 * Solar storms on the globe: GOES flare log, the OVATION auroral oval, the
 * planetary K index and the geomagnetic alert level it implies.
 *
 * Three things are drawn:
 *
 *  - the oval, one dot per OVATION cell at or above the visibility threshold,
 *    brighter with probability — a point collection, because a storm-time band
 *    is thousands of cells and a dot per cell is what keeps that cheap;
 *  - a marker per flare in the last 24 h, placed at the subsolar point of its
 *    peak (see ./sun.js — a flare has no ground coordinate of its own);
 *  - one alert marker at the oval's thickest cell, labelled with the G level,
 *    so the current condition reads without opening anything.
 *
 * A click on a flare or the alert marker opens its fiche. Nothing here holds
 * the render loop: the geometry only changes when a snapshot replaces it.
 * @module layers/spaceWeather
 */
import * as Cesium from 'cesium';
import { createHorizonCuller } from './horizon.js';
import {
  AURORA_VISIBLE_PROBABILITY,
  geomagneticLevel,
  summarizeSpaceWeather,
} from './records.js';
import { subsolarPoint } from './sun.js';
import {
  ALERT_ENTITY_ID,
  AURORA_COLOR,
  LAYER_ID,
  OVERLAY_SOURCE_ID,
  SELECTED_OVERLAY_SOURCE_ID,
  alertColor,
  auroraAlpha,
  buildAlertCard,
  buildFlareCard,
  createAlertOverlayEntry,
  createFlareOverlayEntry,
  createSelectedCardEntry,
  flareColor,
  flareEntityId,
  flareIdFromPick,
  flarePixelSize,
  isAlertPick,
  selectLabelCohort,
} from './policy.js';
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
export { subsolarPoint } from './sun.js';
export { createSpaceWeatherSource } from './source.js';

// A portable package (no i18n): the error stays English data and the panel
// shows it translated.
const msg = (text) => text;
/** Where the alert marker sits when OVATION names no cell. */
const AURORA_ZONE_FALLBACK = Object.freeze({ lat: 67, lon: 0 });

/** The oval's dot colour for one cell probability. */
function auroraCellColor(probability) {
  return Cesium.Color.fromCssColorString(AURORA_COLOR).withAlpha(
    auroraAlpha(probability),
  );
}

/** Own one solar-storm display and its selection. */
export function createSpaceWeatherLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Space weather requires a snapshot source');
  if (!overlayHost?.setEntries)
    throw new TypeError('Space weather requires an overlay host');
  let _viewer = null;
  let _dataSource = null;
  let _aurora = null;
  let _request = null;
  let _enabled = false;
  /** @type {Map<string, object>} */
  let _flaresById = new Map();
  let _summary = null;
  let _auroraCount = 0;
  let _alertPosition = null;
  let _selectedKey = null;
  let _selectedEntity = null;
  let _selectedPosition = null;
  let _clickHandler = null;
  let _lastUpdate = null;
  let _lastError = null;
  /**
   * Everything drawn, with the anchor its visibility is tested at.
   *
   * The planet has no depth of its own here: with Google 3D Tiles the Cesium
   * globe is hidden, and on the keyless globe the points draw over it anyway
   * (`disableDepthTestDistance`). Nothing rejects the far hemisphere, so the
   * oval used to show through the Earth and sweep across the disc whenever the
   * camera turned. The layer culls its own anchors against the ellipsoid, the
   * way the cyclone and fire layers do.
   * @type {Array<{handle: object, position: object}>}
   */
  let _cullables = [];
  let _culler = null;
  let _removePreRender = null;

  /** Hide every anchor the planet is in front of; runs inside preRender. */
  function cullHorizon() {
    if (!_viewer || !_cullables.length) return;
    _culler.setCamera(_viewer.camera.positionWC);
    let changed = false;
    for (const { handle, position } of _cullables) {
      const show = _culler.isVisible(position, handle.show !== false);
      if (handle.show !== show) {
        handle.show = show;
        changed = true;
      }
    }
    if (changed) _viewer.scene.requestRender();
  }

  /** Keep one preRender listener while anything is drawn. */
  function syncCullListener() {
    if (!_viewer) return;
    if (!_cullables.length) {
      _removePreRender?.();
      _removePreRender = null;
      return;
    }
    _culler ||= createHorizonCuller();
    if (_removePreRender) return;
    _removePreRender = _viewer.scene.preRender.addEventListener(cullHorizon);
  }

  function clearCulling() {
    _removePreRender?.();
    _removePreRender = null;
    _cullables = [];
  }

  function clearSelection() {
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    if (_selectedEntity)
      _cullables = _cullables.filter((item) => item.handle !== _selectedEntity);
    _selectedEntity = null;
    _selectedPosition = null;
    _selectedKey = null;
    overlayHost.clearSource(SELECTED_OVERLAY_SOURCE_ID);
  }

  function showSelection(position, copy, accent) {
    const entry = createSelectedCardEntry(_selectedKey, position, copy, accent);
    if (!entry) return;
    overlayHost.setEntries(SELECTED_OVERLAY_SOURCE_ID, [entry], {
      cohortLimit: 1,
      collisionCapacity: 1,
      moving: false,
    });
  }

  function selectFlare(flareId) {
    const flare = _flaresById.get(flareId);
    if (!flare || !_viewer) return;
    clearSelection();
    _selectedKey = flareId;
    const position = Cesium.Cartesian3.fromDegrees(
      flare.subsolar.lon,
      flare.subsolar.lat,
    );
    _selectedEntity = _viewer.entities.add({
      position,
      point: {
        pixelSize: 13,
        color: Cesium.Color.fromCssColorString(flareColor(flare)),
        outlineColor: Cesium.Color.fromCssColorString('#0B1520'),
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    _selectedPosition = position;
    _cullables.push({ handle: _selectedEntity, position });
    syncCullListener();
    cullHorizon();
    showSelection(position, buildFlareCard(flare, t), flareColor(flare));
  }

  function selectAlert() {
    if (!_summary || !_viewer || !_alertPosition) return;
    clearSelection();
    _selectedKey = ALERT_ENTITY_ID;
    _selectedEntity = _viewer.entities.add({
      position: _alertPosition,
      point: {
        pixelSize: 15,
        color: Cesium.Color.fromCssColorString(alertColor(_summary.grade)),
        outlineColor: Cesium.Color.fromCssColorString('#0B1520'),
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    _selectedPosition = _alertPosition;
    _cullables.push({ handle: _selectedEntity, position: _alertPosition });
    syncCullListener();
    cullHorizon();
    showSelection(
      _alertPosition,
      buildAlertCard(_summary, t),
      alertColor(_summary.grade),
    );
  }

  function onKeyDown(event) {
    if (event?.key === 'Escape' && _selectedKey) clearSelection();
  }

  /** Install the click handler; enabling twice keeps one. */
  function installClickHandler(viewer) {
    if (_clickHandler) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      if (_selectedEntity && picked?.id === _selectedEntity) return;
      const pickedId = resolvePickId(picked);
      if (pickedId && isOwnedByOtherLayer(LAYER_ID, pickedId)) return;
      if (isAlertPick(pickedId)) {
        selectAlert();
        return;
      }
      const flareId = flareIdFromPick(pickedId);
      if (flareId && _flaresById.has(flareId)) {
        selectFlare(flareId);
        return;
      }
      if (_selectedKey) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    document.addEventListener('keydown', onKeyDown);
  }

  function removeInteraction() {
    clearSelection();
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    document.removeEventListener('keydown', onKeyDown);
    unregisterPickOwner(LAYER_ID);
  }

  /** Replace the oval with the snapshot's cells, each one culled by the globe. */
  function drawAurora(points) {
    if (!_aurora) return 0;
    _aurora.removeAll();
    for (const cell of points ?? []) {
      const lon = Number(cell[0]);
      const lat = Number(cell[1]);
      const probability = Number(cell[2]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const position = Cesium.Cartesian3.fromDegrees(lon, lat);
      const cellPoint = _aurora.add({
        position,
        pixelSize: 3 + Math.min(3, probability / 30),
        color: auroraCellColor(probability),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      _cullables.push({ handle: cellPoint, position });
    }
    return _aurora.length;
  }

  /** Replace the markers: one per flare, plus the alert anchor. */
  function drawMarkers(snapshot, summary) {
    if (!_dataSource) return { flares: new Map(), entries: [] };
    _dataSource.entities.removeAll();
    const flares = new Map();
    const entries = [];
    for (const flare of snapshot.flares ?? []) {
      const at = Number.isFinite(Number(flare.maxTime))
        ? Number(flare.maxTime)
        : flare.beginTime;
      const sun = subsolarPoint(at);
      const record = { ...flare, subsolar: sun };
      const position = Cesium.Cartesian3.fromDegrees(sun.lon, sun.lat);
      flares.set(flare.id, record);
      const flareEntity = _dataSource.entities.add(
        new Cesium.Entity({
          id: flareEntityId(flare.id),
          position,
          point: {
            pixelSize: flarePixelSize(flare),
            color: Cesium.Color.fromCssColorString(flareColor(flare)).withAlpha(
              0.92,
            ),
            outlineColor:
              Cesium.Color.fromCssColorString('#0B1520').withAlpha(0.8),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: {
            kind: 'flare',
            flareId: flare.id,
            flareClass: flare.maxClass,
            peakTime: at,
          },
        }),
      );
      _cullables.push({ handle: flareEntity, position });
      entries.push(createFlareOverlayEntry(record, position));
    }

    const peak = summary.auroraPeak ?? {};
    const anchor =
      Number.isFinite(Number(peak.lat)) && Number.isFinite(Number(peak.lon))
        ? { lat: Number(peak.lat), lon: Number(peak.lon) }
        : AURORA_ZONE_FALLBACK;
    _alertPosition = Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat);
    const alertEntity = _dataSource.entities.add(
      new Cesium.Entity({
        id: ALERT_ENTITY_ID,
        position: _alertPosition,
        point: {
          pixelSize: 12,
          color: Cesium.Color.fromCssColorString(
            alertColor(summary.grade),
          ).withAlpha(0.95),
          outlineColor:
            Cesium.Color.fromCssColorString('#0B1520').withAlpha(0.85),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: {
          kind: 'alert',
          level: summary.code,
          kp: summary.kp,
        },
      }),
    );
    _cullables.push({ handle: alertEntity, position: _alertPosition });
    entries.push(createAlertOverlayEntry(summary, _alertPosition));
    return { flares, entries };
  }

  function render(snapshot) {
    const summary = summarizeSpaceWeather(snapshot);
    _summary = summary;
    // The handles are rebuilt below, so the previous cull list is stale.
    _cullables = [];
    _auroraCount = drawAurora(snapshot.aurora?.points);
    const { flares, entries } = drawMarkers(snapshot, summary);
    _flaresById = flares;
    // A selection outlives the refresh that rebuilt the markers.
    if (_selectedEntity && _selectedPosition)
      _cullables.push({
        handle: _selectedEntity,
        position: _selectedPosition,
      });
    overlayHost.setEntries(OVERLAY_SOURCE_ID, selectLabelCohort(entries), {
      cohortLimit: 10,
      moving: false,
    });
    syncCullListener();
    cullHorizon();
  }

  return {
    id: LAYER_ID,
    name: 'Solar Storms',
    icon: '☀',
    source: 'NOAA SWPC',
    // SWPC refreshes the oval hourly and the K index every minute; a five
    // minute poll keeps both current without re-reading 900 KB constantly.
    updateInterval: 300000,
    statsRefreshInterval: 1000,

    init(viewer) {
      if (_viewer)
        throw new Error('Space weather layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _aurora = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      viewer.scene.primitives.add(_aurora);
      _aurora.show = false;
      _enabled = false;
      _flaresById = new Map();
      _summary = null;
      _auroraCount = 0;
      _alertPosition = null;
      _lastUpdate = null;
      _lastError = null;
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(SELECTED_OVERLAY_SOURCE_ID, false);
      console.log('[Data:SpaceWeather] Initialized');
    },

    enable(viewer = _viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      if (_aurora) _aurora.show = true;
      overlayHost.setVisible(OVERLAY_SOURCE_ID, true);
      overlayHost.setVisible(SELECTED_OVERLAY_SOURCE_ID, true);
      if (viewer) installClickHandler(viewer);
      registerPickOwner(LAYER_ID, (pickedId) =>
        Boolean(flareIdFromPick(pickedId) || isAlertPick(pickedId)),
      );
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      removeInteraction();
      clearCulling();
      if (_dataSource) _dataSource.show = false;
      if (_aurora) {
        _aurora.removeAll();
        _aurora.show = false;
      }
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(SELECTED_OVERLAY_SOURCE_ID, false);
      _flaresById = new Map();
      _summary = null;
      _auroraCount = 0;
      _alertPosition = null;
    },

    async update(viewer = _viewer) {
      if (!_enabled || !viewer) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        render(snapshot);
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:SpaceWeather] Updated: ${_flaresById.size} flares, ${_auroraCount} oval cells, ${geomagneticLevel(_summary?.kp).code}`,
        );
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:SpaceWeather] Fetch error:', error);
        _lastError = error?.message || msg('Space weather source unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      removeInteraction();
      clearCulling();
      overlayHost.clearSource(OVERLAY_SOURCE_ID);
      overlayHost.setVisible(OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(SELECTED_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      if (_aurora) {
        viewer?.scene?.primitives?.remove(_aurora);
        _aurora = null;
      }
      _viewer = null;
      _flaresById = new Map();
      _summary = null;
      _auroraCount = 0;
      _alertPosition = null;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return {
        count: _flaresById.size,
        lastUpdate: _lastUpdate,
        error: _lastError,
        kp: _summary?.kp ?? null,
        alert: _summary?.code ?? null,
        auroraCells: _auroraCount,
      };
    },
  };
}
