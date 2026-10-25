import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  DOSE_BANDS,
  RADIATION_NETWORKS,
  SPACE_BANDS,
  doseBand,
  formatDose,
  readingsInView,
} from './records.js';
export * from './records.js';
export { createRadiationSource } from './source.js';

/** Station markers are readings, not extents. */
const POINT_PIXELS = 8;
/** Worst readings listed under the layer row. */
const READOUT_LIMIT = 5;

/**
 * Own the ambient dose-rate display and its refresh lifecycle.
 *
 * Stations arrive already normalized to µSv/h by the server route, so the layer
 * only colours, places and counts them. Space radiation (GOES protons and the
 * planetary K index) has no place on the globe: it is one line of context
 * under the legend, which keeps the physical map honest and the reading
 * visible.
 * @param {object} options
 * @param {{getSnapshot: Function}} options.source
 * @returns {object} Layer module.
 */
export function createRadiationLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Radiation requires a snapshot source');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _stations = [];
  let _space = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  const viewRectangle = () => {
    const rectangle = _viewer?.camera?.computeViewRectangle?.();
    if (!rectangle) return null;
    const toDeg = Cesium.Math.toDegrees;
    return {
      west: toDeg(rectangle.west),
      south: toDeg(rectangle.south),
      east: toDeg(rectangle.east),
      north: toDeg(rectangle.north),
    };
  };

  const render = () => {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    for (const station of _stations) {
      const band = doseBand(station.usvh);
      if (!band) continue;
      _dataSource.entities.add(
        new Cesium.Entity({
          id: `radiation:${station.network}:${station.id}`,
          position: Cesium.Cartesian3.fromDegrees(station.lon, station.lat),
          point: {
            pixelSize: POINT_PIXELS,
            color: Cesium.Color.fromCssColorString(band.color),
            outlineColor:
              Cesium.Color.fromCssColorString('#08161c').withAlpha(0.9),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
          properties: {
            network: station.network,
            stationName: station.name,
            usvh: station.usvh,
            at: station.at,
            estimated: Boolean(station.estimated),
          },
        }),
      );
    }
  };

  const spaceLine = () => {
    if (!_space) return null;
    const parts = [];
    if (Number.isFinite(_space.protonFlux))
      parts.push(
        t('protons ≥10 MeV {flux} pfu', {
          flux: _space.protonFlux.toFixed(2),
        }),
      );
    if (Number.isFinite(_space.kp)) parts.push(t('Kp {kp}', { kp: _space.kp }));
    if (!parts.length) return null;
    const band = SPACE_BANDS[_space.band] || SPACE_BANDS.calm;
    return `${t('Space radiation')} · ${parts.join(' · ')} · ${t(band.label)}`;
  };

  const layer = {
    id: 'radiation',
    name: 'Radiation',
    icon: '☢',
    source: 'BfS ODL · Health Canada · Safecast · radmon.org · uRADMonitor',
    updateInterval: 600_000,

    init(viewer) {
      if (_viewer) throw new Error('Radiation layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('radiation');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _stations = [];
      _space = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:Radiation] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      notify();
    },

    disable() {
      // A response landing after disable must not redraw the globe.
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
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _stations = snapshot.stations;
        _space = snapshot.space;
        render();
        _count = _stations.length;
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || msg('Radiation source unavailable');
        console.warn('[Data:Radiation] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },

    /**
     * Legend, worst readings in view and the space-radiation line for the
     * Layers panel row. Everything shown here is derived from the last
     * snapshot, so a failed refresh leaves the previous truth on screen.
     */
    getRowControls() {
      const counts = new Map(DOSE_BANDS.map((band) => [band.id, 0]));
      for (const station of _stations) {
        const band = doseBand(station.usvh);
        if (band) counts.set(band.id, (counts.get(band.id) || 0) + 1);
      }
      const inView = readingsInView(_stations, viewRectangle(), READOUT_LIMIT);
      return {
        legend: DOSE_BANDS.map((band) => ({
          color: band.color,
          label: t(band.label),
          count: counts.get(band.id) || 0,
        })),
        info: spaceLine() || undefined,
        infoTitle: _lastError ? translateFeedError(_lastError) : undefined,
        list: {
          ordered: false,
          ariaLabel: t('Highest radiation readings in view'),
          items: inView.map((station, index) => {
            const network = RADIATION_NETWORKS[station.network];
            const band = doseBand(station.usvh);
            return {
              id: `${station.network}:${station.id}`,
              ordinal: index + 1,
              lead: `${formatDose(station.usvh)} µSv/h`,
              text: [station.name || network?.label || station.network]
                .concat(network && station.name ? [network.label] : [])
                .join(' · '),
              accent: band?.color,
            };
          }),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Snapshot readings as JSON-safe records for the analyst query engine.
     * @param {number} [maxCount=500]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_stations.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return _stations.slice(0, limit).map((station) => ({
        layerId: 'radiation',
        id: `${station.network}:${station.id}`,
        network: station.network,
        name: station.name,
        lat: station.lat,
        lon: station.lon,
        usvh: station.usvh,
        at: station.at,
      }));
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      _stations = [];
      _space = null;
      rowControlsListener = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },
  };
  return layer;
}
