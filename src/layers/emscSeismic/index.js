import * as Cesium from 'cesium';
import {
  EMSC_OVERLAY_SOURCE_ID,
  EMSC_OVERLAY_COHORT_LIMIT,
  EMSC_OVERLAY_COLLISION_CAPACITY,
  depthColor,
  createEmscOverlayEntry,
  selectEmscOverlayCohort,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createEmscEarthquakeSource } from './source.js';

// A portable package (no i18n): the error stays English data and the layer
// panel shows it translated.
const msg = (text) => text;

/** Own one EMSC earthquake display and its refresh lifecycle. */
export function createEmscSeismicLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('EMSC seismic requires a snapshot source');
  if (!overlayHost)
    throw new TypeError('EMSC seismic requires an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'emsc-seismic',
    name: 'Earthquakes (EMSC)',
    icon: '🌐',
    source: 'EMSC',
    updateInterval: 60000,

    init(viewer) {
      if (_viewer) throw new Error('EMSC seismic layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('emsc-seismic');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(EMSC_OVERLAY_SOURCE_ID, false);
      console.log('[Data:EmscSeismic] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      // No continuous-render hold: the discs are static geometry now, so the
      // layer has no per-frame animator to keep the render loop alive for.
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(EMSC_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(EMSC_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EMSC_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const nextEntities = [];
        let count = 0;
        const overlayEntries = [];

        for (const {
          stableId,
          emscId,
          lon,
          lat,
          depthKm,
          mag,
          place,
          time,
        } of rows) {
          count++;
          const baseRadius = Math.pow(2, mag) * 1000;
          const color = depthColor(depthKm || 0);
          const isSignificant = mag >= 5.0;
          const fillAlpha = isSignificant ? 0.4 : 0.3;
          const outlineAlpha = isSignificant ? 1.0 : 0.8;

          const position = Cesium.Cartesian3.fromDegrees(lon, lat);
          nextEntities.push(
            new Cesium.Entity({
              id: `earthquake:emsc:${stableId}`,
              position,
              ellipse: {
                // Static axes — see the module header. A CallbackProperty here
                // re-tessellates the clamped ground geometry every frame.
                semiMajorAxis: baseRadius,
                semiMinorAxis: baseRadius,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(fillAlpha),
                ),
                outline: true,
                outlineColor: color.withAlpha(outlineAlpha),
                outlineWidth: isSignificant ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                // Analyst seam (additive): the EMSC unid (e.g. "20261103_0000071").
                emscId,
                mag,
                place,
                time,
                depth: depthKm,
              },
            }),
          );
          overlayEntries.push(
            createEmscOverlayEntry({
              id: String(stableId),
              position,
              magnitude: mag,
              accent: color.toCssColorString(),
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        if (_enabled) {
          overlayHost.setEntries(
            EMSC_OVERLAY_SOURCE_ID,
            selectEmscOverlayCohort(overlayEntries),
            {
              cohortLimit: EMSC_OVERLAY_COHORT_LIMIT,
              collisionCapacity: EMSC_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:EmscSeismic] Updated: ${_count} events (EMSC M2.5+)`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:EmscSeismic] Fetch error:', e);
        _lastError = e?.message || msg('EMSC seismic source unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      overlayHost.clearSource(EMSC_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EMSC_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Snapshot the layer's in-memory earthquake records as plain JSON-safe
     * objects for the analyst query engine. On-demand only (called at most
     * once per spoken query) — zero per-frame cost, no listeners, no caching.
     * Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const cartesian = entity.position
          ? entity.position.getValue(now)
          : null;
        const carto = cartesian
          ? Cesium.Cartographic.fromCartesian(cartesian)
          : null;
        const p = entity.properties;
        result.push(
          mapAnalystRecord(
            {
              id: p?.emscId?.getValue(now) ?? null,
              mag: p?.mag?.getValue(now),
              place: p?.place?.getValue(now),
              time: p?.time?.getValue(now),
              depth: p?.depth?.getValue(now),
              lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
              lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
            },
            result.length,
          ),
        );
      }
      return result;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
