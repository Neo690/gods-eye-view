/**
 * Israeli companies' documented transport activity, drawn as a layer.
 *
 * The dataset is bundled (see ./data.js), so the layer needs no server, no key
 * and no network: it draws the same sites on a desktop, in a browser and inside
 * the APK. Each site is one marker; a click opens a card that reads as a short
 * fiche — company and sector, the work, the company's role, the state of it,
 * and the country with the host of the page it came from.
 *
 * Deliberately not a live feed: a curated record does not change between two
 * frames, and pretending otherwise would poll a source that has nothing new to
 * say.
 *
 * @module layers/israeliTransport
 */
import * as Cesium from 'cesium';
import {
  ACTIVITY_COLOR,
  ACTIVITY_OVERLAY_SOURCE_ID,
  ACTIVITY_PIXEL_SIZE,
  ACTIVITY_SELECTED_COLOR,
  ACTIVITY_SELECTED_OVERLAY_SOURCE_ID,
  ACTIVITY_SELECTED_PIXEL_SIZE,
  CARD_COHORT_LIMIT,
  ENTITY_PREFIX,
  LAYER_ID,
  activityIdFromPick,
  buildActivityCard,
  createActivityOverlayEntry,
  createSelectedActivityEntry,
  selectActivityCohort,
} from './policy.js';
import { TRANSPORT_ACTIVITIES } from './data.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { t } from '../../i18n/index.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';

export * from './policy.js';
export * from './data.js';

/**
 * Own one transport-activity display and its selection.
 * @param {object} options
 * @param {object} options.overlayHost Ambient-card host (see app/localGeojsonServices).
 * @param {ReadonlyArray<object>} [options.activities] Dataset override for tests.
 * @returns {object} The manager-facing layer.
 */
export function createIsraeliTransportLayer({
  overlayHost,
  activities = TRANSPORT_ACTIVITIES,
} = {}) {
  if (!overlayHost?.setEntries)
    throw new TypeError('Transport activities require an overlay host');
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _recordsById = new Map();
  let _selectedKey = null;
  let _selectedEntity = null;
  let _clickHandler = null;
  let _lastUpdate = null;

  function clearSelection() {
    if (_selectedEntity && _viewer) _viewer.entities.remove(_selectedEntity);
    _selectedEntity = null;
    _selectedKey = null;
    overlayHost.clearSource(ACTIVITY_SELECTED_OVERLAY_SOURCE_ID);
  }

  /** Draw every site once; the dataset does not move. */
  function build() {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    const cards = [];
    const byId = new Map();
    for (const record of activities) {
      const position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
      _dataSource.entities.add(
        new Cesium.Entity({
          id: `${ENTITY_PREFIX}${record.id}`,
          position,
          point: {
            pixelSize: ACTIVITY_PIXEL_SIZE,
            color:
              Cesium.Color.fromCssColorString(ACTIVITY_COLOR).withAlpha(0.9),
            outlineColor: Cesium.Color.fromCssColorString(
              record.sector === 'shipping' ? '#4FD1C5' : ACTIVITY_COLOR,
            ).withAlpha(0.7),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: {
            company: record.company,
            sector: record.sector,
            country: record.country,
            place: record.place,
            status: record.status,
            source: record.source?.url,
          },
        }),
      );
      byId.set(record.id, record);
      cards.push(createActivityOverlayEntry(record, position));
    }
    _recordsById = byId;
    overlayHost.setEntries(
      ACTIVITY_OVERLAY_SOURCE_ID,
      selectActivityCohort(cards, CARD_COHORT_LIMIT),
      {
        cohortLimit: CARD_COHORT_LIMIT,
        moving: false,
      },
    );
    _lastUpdate = Date.now();
  }

  function selectActivity(activityId) {
    const record = _recordsById.get(activityId);
    if (!record || !_viewer) return;
    clearSelection();
    const position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
    _selectedKey = activityId;
    _selectedEntity = _viewer.entities.add({
      position,
      point: {
        pixelSize: ACTIVITY_SELECTED_PIXEL_SIZE,
        color: Cesium.Color.fromCssColorString(ACTIVITY_SELECTED_COLOR),
        outlineColor: Cesium.Color.fromCssColorString(ACTIVITY_COLOR),
        outlineWidth: 2,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    const entry = createSelectedActivityEntry(
      record,
      position,
      buildActivityCard(record, t),
    );
    if (entry)
      overlayHost.setEntries(ACTIVITY_SELECTED_OVERLAY_SOURCE_ID, [entry], {
        cohortLimit: 1,
        collisionCapacity: 1,
        moving: false,
      });
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
      const activityId = activityIdFromPick(pickedId);
      if (activityId && _recordsById.has(activityId)) {
        selectActivity(activityId);
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

  return {
    id: LAYER_ID,
    name: 'Israeli Transport Sites',
    icon: '\u25C8',
    source: 'Company and agency publications',
    // A curated record does not change between frames; the manager only needs
    // its periodic status tick, not a refresh loop.
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init(viewer) {
      if (_viewer) throw new Error('Transport layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _enabled = false;
      _selectedKey = null;
      _selectedEntity = null;
      _recordsById = new Map();
      _lastUpdate = null;
      overlayHost.setVisible(ACTIVITY_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(ACTIVITY_SELECTED_OVERLAY_SOURCE_ID, false);
    },

    enable(viewer = _viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      build();
      overlayHost.setVisible(ACTIVITY_OVERLAY_SOURCE_ID, true);
      overlayHost.setVisible(ACTIVITY_SELECTED_OVERLAY_SOURCE_ID, true);
      if (viewer) installClickHandler(viewer);
      registerPickOwner(LAYER_ID, (pickedId) =>
        Boolean(activityIdFromPick(pickedId)),
      );
    },

    disable() {
      _enabled = false;
      removeInteraction();
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(ACTIVITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(ACTIVITY_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(ACTIVITY_SELECTED_OVERLAY_SOURCE_ID, false);
      _recordsById = new Map();
    },

    update() {
      return Boolean(_enabled);
    },

    destroy() {
      _enabled = false;
      removeInteraction();
      overlayHost.clearSource(ACTIVITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(ACTIVITY_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(ACTIVITY_SELECTED_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        _viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _recordsById = new Map();
      _lastUpdate = null;
    },

    getStats() {
      return {
        count: _enabled ? _recordsById.size : 0,
        lastUpdate: _lastUpdate,
        error: null,
      };
    },
  };
}
