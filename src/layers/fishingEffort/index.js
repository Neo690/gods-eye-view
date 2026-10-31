import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  DEFAULT_DAYS,
  FISHING_EFFORT_LAYER_ID,
  activityZones,
  boundsFromRadians,
  effortSummary,
  hoursCeiling,
  intensity,
  viewportAllowed,
} from './model.js';
export * from './model.js';
export { createFishingEffortSource } from './sources.js';

/** GFW answers daily aggregates; half an hour is already generous. */
const UPDATE_MS = 30 * 60_000;

/**
 * Apparent fishing effort from Global Fishing Watch, drawn as gridded fishing
 * hours behind the current view. A cell is a sum over a 0.1° square, not a
 * vessel: the layer answers "where is fishing concentrated", and its row says
 * so, because treating it as a live contact would be wrong.
 *
 * @param {object} options
 * @param {{getSnapshot: Function}} options.source
 * @param {Function} [options.now]
 */
export function createFishingEffortLayer({
  source,
  now = () => Date.now(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Fishing effort requires a snapshot source');

  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _snapshot = null;
  let _error = null;
  let _lastUpdate = null;
  let _enabled = false;
  let _note = null;
  let _count = 0;
  let _zoneCount = 0;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  const bounds = () => {
    const rectangle = _viewer?.camera?.computeViewRectangle?.();
    if (!rectangle) return null;
    return boundsFromRadians(rectangle);
  };

  /** One ring's degrees flattened for Cesium, closed back onto its start. */
  const ringArray = (positions) => {
    const flat = [];
    for (const point of positions) flat.push(point.lon, point.lat);
    if (positions.length) flat.push(positions[0].lon, positions[0].lat);
    return flat;
  };

  /**
   * The activity zones: a translucent fill over each dense cluster and a bright
   * outline on every ring. The cells stay underneath — the outline says where
   * the effort is concentrated, the cells say how it is distributed inside.
   */
  const renderZones = (cells, ceiling) => {
    const zones = activityZones(cells, { ceiling });
    for (const zone of zones) {
      zone.outlines.forEach((outline, outlineIndex) => {
        const [outer, ...holes] = outline.rings;
        if (!outer) return;
        _dataSource.entities.add(
          new Cesium.Entity({
            id: `fishing-zone-fill:${zone.id}:${outlineIndex}`,
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(ringArray(outer.positions)),
                holes.map(
                  (ring) =>
                    new Cesium.PolygonHierarchy(
                      Cesium.Cartesian3.fromDegreesArray(
                        ringArray(ring.positions),
                      ),
                    ),
                ),
              ),
              material: Cesium.Color.fromCssColorString('#38B2C4').withAlpha(
                0.05 + zone.intensity * 0.1,
              ),
              height: 0,
            },
            properties: {
              source: FISHING_EFFORT_LAYER_ID,
              zone: true,
              hours: zone.totalHours,
              cells: zone.cellCount,
            },
          }),
        );
        outline.rings.forEach((ring, ringIndex) => {
          _dataSource.entities.add(
            new Cesium.Entity({
              id: `fishing-zone:${zone.id}:${outlineIndex}:${ringIndex}`,
              polyline: {
                positions: Cesium.Cartesian3.fromDegreesArray(
                  ringArray(ring.positions),
                ),
                // A zone's border says "this is the area", so it is drawn wider
                // than a cell's outline and never below visible width.
                width: 1.2 + zone.intensity * 1.8,
                material: Cesium.Color.fromCssColorString('#7FE3F0').withAlpha(
                  0.4 + zone.intensity * 0.45,
                ),
                arcType: Cesium.ArcType.GEODESIC,
              },
              properties: {
                source: FISHING_EFFORT_LAYER_ID,
                zone: true,
                ring: ringIndex,
                hours: zone.totalHours,
                cells: zone.cellCount,
              },
            }),
          );
        });
      });
    }
    return zones.length;
  };

  const render = () => {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    const cells = _snapshot?.cells || [];
    const ceiling = hoursCeiling(cells);
    let painted = 0;
    for (const cell of cells) {
      const share = intensity(cell.hours, ceiling);
      if (share <= 0) continue;
      _dataSource.entities.add(
        new Cesium.Entity({
          id: `fishing:${cell.lat.toFixed(2)}:${cell.lon.toFixed(2)}`,
          position: Cesium.Cartesian3.fromDegrees(cell.lon, cell.lat),
          point: {
            pixelSize: 3 + share * 11,
            color: Cesium.Color.fromCssColorString('#38B2C4').withAlpha(
              0.15 + share * 0.75,
            ),
            outlineColor:
              Cesium.Color.fromCssColorString('#06141a').withAlpha(0.35),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.NONE,
          },
          properties: {
            source: FISHING_EFFORT_LAYER_ID,
            hours: cell.hours,
          },
        }),
      );
      painted++;
    }
    _count = painted;
    // Zones are aggregates of the cells above: they are computed from the same
    // snapshot, on the same ceiling, so the outline and the dots always agree.
    _zoneCount = renderZones(cells, ceiling);
  };

  const layer = {
    id: FISHING_EFFORT_LAYER_ID,
    name: 'Fishing Effort',
    icon: '🐟',
    source: 'Global Fishing Watch',
    updateInterval: UPDATE_MS,

    init(viewer) {
      if (_viewer) throw new Error('Fishing effort is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(FISHING_EFFORT_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _snapshot = null;
      _error = null;
      _lastUpdate = null;
      _note = null;
      _count = 0;
      _zoneCount = 0;
      _enabled = false;
      console.log('[Data:FishingEffort] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      notify();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) {
        _dataSource.show = false;
        _dataSource.entities.removeAll();
      }
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      const view = bounds();
      if (!view) {
        _note = t('No view to load');
        notify();
        return false;
      }
      if (!viewportAllowed(view)) {
        // A hemisphere of daily aggregates is megabytes of ocean for a picture
        // nobody can read; the row asks for a closer view instead.
        _note = t('Zoom in to load fishing effort');
        _snapshot = { cells: [], totalHours: 0, cellCount: 0 };
        render();
        notify();
        return false;
      }
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const answer = await source.getSnapshot({
          ...view,
          days: DEFAULT_DAYS,
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        if (!answer.ok) {
          _error = answer.error || 'missing-key';
          _snapshot = { cells: [], totalHours: 0, cellCount: 0 };
          _note = null;
          render();
          notify();
          return false;
        }
        _snapshot = answer;
        _error = null;
        _note = null;
        render();
        _lastUpdate = now();
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _error = error?.message || msg('Fishing effort unavailable');
        console.warn('[Data:FishingEffort] Refresh failed:', _error);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    getStats() {
      return {
        count: _count,
        zoneCount: _zoneCount,
        totalHours: _snapshot?.totalHours || 0,
        lastUpdate: _lastUpdate,
        error: _error,
      };
    },

    getRowControls() {
      const summary = effortSummary({
        totalHours: _snapshot?.totalHours,
        cellCount: _snapshot?.cellCount,
        days: DEFAULT_DAYS,
      });
      const stale = _snapshot?.stale ? t('Cached report') : null;
      // The zone count is part of the row, not only of the globe: an outline
      // is hard to count by eye, and "no zone" is the honest answer when the
      // effort is spread too thin to group.
      const zones = _zoneCount
        ? t('Zones: {count}', { count: _zoneCount })
        : null;
      return {
        info:
          _note ||
          [summary, zones, stale].filter(Boolean).join(' · ') ||
          undefined,
        infoTitle: _error
          ? _error === 'missing-key'
            ? t('Needs a Global Fishing Watch token')
            : translateFeedError(_error)
          : undefined,
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /** JSON-safe snapshot for the analyst query engine. */
    getAnalystRecords(maxCount = 400) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 400;
      return (_snapshot?.cells || []).slice(0, limit).map((cell) => ({
        layerId: FISHING_EFFORT_LAYER_ID,
        source: 'global-fishing-watch',
        lat: cell.lat,
        lon: cell.lon,
        hours: cell.hours,
        days: DEFAULT_DAYS,
      }));
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      _snapshot = null;
      _error = null;
      _lastUpdate = null;
      _note = null;
      _count = 0;
      _zoneCount = 0;
      rowControlsListener = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
    },
  };
  return layer;
}
