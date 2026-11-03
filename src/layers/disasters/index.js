import * as Cesium from 'cesium';
import {
  ACTIVATION_RADIUS_M,
  alertColor,
  eventRadiusMeters,
  fireAreaColor,
  mapAnalystRecords,
} from './model.js';
export * from './model.js';
export { createGlobalDisastersSource } from './source.js';

/**
 * The disasters layer owns three display kinds over one snapshot:
 *
 *  - `event` — GDACS point events, alert-coloured ellipses, no render hold;
 *  - `activation` — Copernicus EMS rapid-mapping activations, small amber
 *    pins that persist while an activation is open;
 *  - `fire` — EFFIS burnt-area polygons, filled by mapped hectares with a
 *    thin ground-clamped outline like the fire-perimeters layer.
 *
 * Complement feeds that answer an unusable snapshot simply contribute no
 * rows; the GDACS primary failing fails the whole update.
 * @module layers/disasters
 */

const msg = (text) => text;

function ringPositions(ring) {
  return ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
}

/** Own one Global disasters display and its refresh lifecycle. */
export function createGlobalDisastersLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Global disasters requires a snapshot source');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _perSource = null;
  let _records = [];
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _lastSignature = null;

  const layer = {
    id: 'global-disasters',
    name: 'Global disasters',
    icon: '⚠️',
    source: 'GDACS',
    updateInterval: 120000,

    init(viewer) {
      if (_viewer)
        throw new Error('Global disasters layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('global-disasters');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _perSource = null;
      _records = [];
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:Disasters] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
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
        if (!Array.isArray(rows))
          throw new Error('Malformed disasters snapshot');

        // Facts change per feed; a byte-identical snapshot re-publishes nothing.
        const signature = rows
          .map((row) => row.stableId)
          .sort()
          .join('|');
        const signatureSame = signature === _lastSignature;
        _lastSignature = signature;

        const counts = { event: 0, activation: 0, fire: 0 };
        const nextEntities = [];
        const facts = [];
        for (const row of rows) {
          counts[row.kind] = (counts[row.kind] ?? 0) + 1;
          facts.push({
            id: row.stableId,
            hazard: row.hazard,
            name: row.name,
            country: row.country,
            alertLevel: row.alertLevel,
            timeMs: row.timeMs,
            areaHa: row.areaHa,
            lat: row.lat,
            lon: row.lon,
          });
        }
        _records = mapAnalystRecords(facts);
        if (!signatureSame) {
          for (const row of rows) {
            const colorTuple =
              row.kind === 'fire'
                ? fireAreaColor(row.areaHa)
                : alertColor(row.alertLevel);
            const color = new Cesium.Color(
              colorTuple[0] / 255,
              colorTuple[1] / 255,
              colorTuple[2] / 255,
            );
            if (row.kind === 'fire' && Array.isArray(row.rings)) {
              for (const ring of row.rings) {
                const positions = ringPositions(ring);
                nextEntities.push(
                  new Cesium.Entity({
                    id: `disaster:${row.stableId}:fire:${
                      nextEntities.length
                    }`,
                    polygon: {
                      hierarchy: new Cesium.PolygonHierarchy(positions),
                      material: new Cesium.ColorMaterialProperty(
                        color.withAlpha(0.3),
                      ),
                      classificationType: Cesium.ClassificationType.BOTH,
                    },
                    polyline: {
                      positions,
                      clampToGround: true,
                      width: 1.5,
                      material: new Cesium.ColorMaterialProperty(
                        color.withAlpha(0.85),
                      ),
                    },
                  }),
                );
              }
              continue;
            }
            if (row.kind === 'activation') {
              nextEntities.push(
                new Cesium.Entity({
                  id: `disaster:${row.stableId}:activation`,
                  position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
                  ellipse: {
                    semiMajorAxis: ACTIVATION_RADIUS_M,
                    semiMinorAxis: ACTIVATION_RADIUS_M,
                    material: new Cesium.ColorMaterialProperty(
                      color.withAlpha(0.3),
                    ),
                    outline: true,
                    outlineColor: color.withAlpha(0.9),
                    outlineWidth: 2,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                  },
                }),
              );
              continue;
            }
            const radius = eventRadiusMeters({
              severity: row.severity,
              alertLevel: row.alertLevel,
            });
            nextEntities.push(
              new Cesium.Entity({
                id: `disaster:${row.stableId}:event`,
                position: Cesium.Cartesian3.fromDegrees(row.lon, row.lat),
                ellipse: {
                  semiMajorAxis: radius,
                  semiMinorAxis: radius,
                  material: new Cesium.ColorMaterialProperty(
                    color.withAlpha(0.28),
                  ),
                  outline: true,
                  outlineColor: color.withAlpha(0.9),
                  outlineWidth: 2,
                  heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                },
              }),
            );
          }
          _dataSource.entities.removeAll();
          for (const entity of nextEntities) _dataSource.entities.add(entity);
        }

        _count = rows.length;
        _perSource = counts;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:Disasters] Updated: ${counts.event ?? 0} events, ${
            counts.activation ?? 0
          } activations, ${
            counts.fire ?? 0
          } burnt areas (GDACS + Copernicus EMS + EFFIS)`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Disasters] Fetch error:', e);
        _lastError = e?.message || msg('Global disasters source unavailable');
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
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _lastSignature = null;
      _records = [];
    },

    /**
     * Retained analyst facts (geometry stripped at update time), so a spoken
     * query costs nothing per frame and no Cesium value unwrapping is needed.
     * @param {number} [maxCount=2000]
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      return mapAnalystRecords(_records, { maxCount });
    },

    getStats() {
      return {
        count: _count,
        perSource: _perSource,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
