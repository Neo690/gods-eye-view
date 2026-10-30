import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  ORBIT_CHANGE_BASELINE_STORAGE_KEY,
  ORBIT_CHANGE_LAYER_ID,
  ORBIT_CHANGE_THRESHOLDS,
  baselineFromCatalog,
  createOrbitChangeOverlayEntry,
  formatEpoch,
  orbitChangeAccent,
  orbitalChanges,
  selectOrbitChangeCohort,
} from './model.js';
export * from './model.js';
export { createOrbitChangeSource } from './source.js';

/** A marker is one satellite, not an extent. */
const POINT_PIXELS = 6;
/** How long a reported change stays on the globe. */
const EVENT_TTL_MS = 24 * 3600 * 1000;
/** Ambient labels: the cohort only. */
const LABEL_LIMIT = 12;

/** localStorage, or nothing at all when the host has no storage. */
function readDefaultStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = '__gev_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function readStoredBaseline(storage) {
  if (!storage?.getItem) return null;
  try {
    const raw = storage.getItem(ORBIT_CHANGE_BASELINE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.objects || typeof parsed.objects !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredBaseline(storage, baseline) {
  if (!storage?.setItem) return;
  try {
    storage.setItem(
      ORBIT_CHANGE_BASELINE_STORAGE_KEY,
      JSON.stringify(baseline),
    );
  } catch {
    // A full or read-only store costs the next session its comparison, never
    // this one's display.
  }
}

/**
 * Own the inferred-orbit-change display.
 *
 * Two rules keep the layer honest. It only ever says an *orbit changed*: a TLE
 * is a fit, and a fit that moves is not proof of a burn. And it never reports
 * an object it has not seen before — a launch, a decay or a catalog edit would
 * otherwise read as a manoeuvre.
 *
 * The first refresh of a fresh install records a baseline and reports nothing:
 * there is no previous element set to compare against, and inventing one from
 * the same body would report zero forever.
 *
 * @param {object} options
 * @param {{readCatalog: Function}} options.source
 * @param {object} [options.overlayHost]
 * @param {object|null} [options.storage]
 * @returns {object} Layer module.
 */
export function createOrbitChangesLayer({
  source,
  overlayHost = null,
  storage,
  now = () => Date.now(),
} = {}) {
  if (typeof source?.readCatalog !== 'function')
    throw new TypeError('Orbit changes require a catalog source');
  if (overlayHost != null && !overlayHost.setEntries)
    throw new TypeError('Orbit change overlay host must publish entries');

  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _store = storage === undefined ? readDefaultStorage() : storage;
  /** norad -> event, newest wins. */
  let _events = new Map();
  let _groups = [];
  let _stale = false;
  let _awaitingBaseline = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  const liveEvents = () => {
    const cutoff = now() - EVENT_TTL_MS;
    const events = [];
    for (const [norad, event] of _events) {
      // Expire on when the change was observed, not on the element set's own
      // epoch: a TLE epoch can already be hours old when the proxy serves it.
      if ((event.observedAt ?? event.epoch) < cutoff) _events.delete(norad);
      else events.push(event);
    }
    events.sort(
      (a, b) => b.priority - a.priority || a.norad.localeCompare(b.norad),
    );
    return events;
  };

  const render = () => {
    if (!_dataSource) return;
    const events = liveEvents();
    _dataSource.entities.removeAll();
    for (const event of events) {
      _dataSource.entities.add(
        new Cesium.Entity({
          id: `orbit-change:${event.norad}`,
          position: Cesium.Cartesian3.fromDegrees(event.lon, event.lat),
          point: {
            pixelSize: POINT_PIXELS,
            color: Cesium.Color.fromCssColorString(
              orbitChangeAccent(event.deltaVMps),
            ),
            outlineColor:
              Cesium.Color.fromCssColorString('#08161c').withAlpha(0.9),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
          properties: {
            norad: event.norad,
            satellite: event.name,
            epoch: event.epoch,
            deltaAltitudeKm: event.deltaAltitudeKm,
            deltaInclinationDeg: event.deltaInclinationDeg,
            deltaVMps: event.deltaVMps,
          },
        }),
      );
    }
    _count = events.length;
    if (!overlayHost) return;
    // Labels only for the costliest changes: the rest are dots.
    const entries = selectOrbitChangeCohort(
      events.map((event) =>
        createOrbitChangeOverlayEntry(
          event,
          Cesium.Cartesian3.fromDegrees(event.lon, event.lat),
          t,
        ),
      ),
      LABEL_LIMIT,
    );
    overlayHost.setEntries(ORBIT_CHANGE_LAYER_ID, entries, {
      cohortLimit: LABEL_LIMIT,
      moving: false,
    });
  };

  const layer = {
    id: ORBIT_CHANGE_LAYER_ID,
    name: 'Orbit Changes',
    icon: '🛰',
    source: 'CelesTrak element sets',
    // Element sets are republished a few times a day; a quarter-hour poll is
    // already faster than the data changes.
    updateInterval: 900_000,

    init(viewer) {
      if (_viewer) throw new Error('Orbit change layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(ORBIT_CHANGE_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _events = new Map();
      _groups = [];
      _stale = false;
      _awaitingBaseline = false;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost?.setVisible(ORBIT_CHANGE_LAYER_ID, false);
      console.log('[Data:OrbitChanges] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible(ORBIT_CHANGE_LAYER_ID, true);
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
      overlayHost?.clearSource(ORBIT_CHANGE_LAYER_ID);
      overlayHost?.setVisible(ORBIT_CHANGE_LAYER_ID, false);
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const catalog = await source.readCatalog({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        if (!catalog.entries.length)
          throw new Error(msg('No element sets returned'));

        _groups = catalog.groups;
        _stale = Boolean(catalog.stale);
        const previous = readStoredBaseline(_store);
        const next = baselineFromCatalog(catalog.entries);
        if (!previous) {
          // Nothing to diff against yet: record it and say so.
          writeStoredBaseline(_store, next);
          _awaitingBaseline = true;
          _events = new Map();
          render();
          _lastUpdate = now();
          _lastError = null;
          notify();
          return true;
        }

        _awaitingBaseline = false;
        const observedAt = now();
        for (const event of orbitalChanges(previous, catalog.entries)) {
          _events.set(event.norad, { ...event, observedAt });
        }
        // Only publish the new baseline once the comparison is done: a crash
        // between the two would silently swallow the changes it held.
        writeStoredBaseline(_store, next);
        render();
        _lastUpdate = now();
        _lastError = null;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _lastError = error?.message || msg('Orbit change source unavailable');
        console.warn('[Data:OrbitChanges] Refresh failed:', _lastError);
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

    /** What the Layers panel row shows under the name. */
    getRowControls() {
      const events = liveEvents();
      const thresholds = ORBIT_CHANGE_THRESHOLDS;
      const legend = [
        { color: orbitChangeAccent(0), label: '< 5 m/s' },
        { color: orbitChangeAccent(10), label: '5–30 m/s' },
        { color: orbitChangeAccent(40), label: '> 30 m/s' },
      ].map((entry) => ({ ...entry, count: 0 }));
      for (const event of events) {
        const bucket = event.deltaVMps < 5 ? 0 : event.deltaVMps < 30 ? 1 : 2;
        legend[bucket].count++;
      }

      let info;
      if (_awaitingBaseline) {
        info = t('Baseline recorded · changes appear on the next refresh');
      } else if (events.length) {
        info = t('Inferred orbit changes: {count} · estimated Δv', {
          count: events.length,
        });
      }

      return {
        legend,
        info,
        infoTitle: _lastError
          ? translateFeedError(_lastError)
          : _stale
            ? t('CelesTrak served its last copy')
            : undefined,
        list: {
          ordered: false,
          ariaLabel: t('Largest inferred orbit changes'),
          items: events.slice(0, 6).map((event, index) => ({
            id: event.norad,
            ordinal: index + 1,
            lead: `${Math.round(event.deltaVMps)} m/s`,
            text: [
              event.name,
              `${Math.round(event.deltaAltitudeKm)} km`,
              formatEpoch(event.epoch),
            ].join(' · '),
            accent: orbitChangeAccent(event.deltaVMps),
          })),
        },
        footnote: t(
          'Inferred from successive element sets, not from a confirmed burn. Thresholds: {altitude} km, {inclination}°, {eccentricity}.',
          {
            altitude: thresholds.altitudeKm,
            inclination: thresholds.inclinationDeg,
            eccentricity: thresholds.eccentricity,
          },
        ),
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getAnalystRecords(maxCount = 300) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 300;
      return liveEvents()
        .slice(0, limit)
        .map((event) => ({
          layerId: ORBIT_CHANGE_LAYER_ID,
          id: event.norad,
          name: event.name,
          lat: event.lat,
          lon: event.lon,
          epoch: event.epoch,
          deltaAltitudeKm: event.deltaAltitudeKm,
          deltaInclinationDeg: event.deltaInclinationDeg,
          deltaVMps: event.deltaVMps,
        }));
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      _events = new Map();
      _groups = [];
      _stale = false;
      _awaitingBaseline = false;
      rowControlsListener = null;
      overlayHost?.clearSource(ORBIT_CHANGE_LAYER_ID);
      overlayHost?.setVisible(ORBIT_CHANGE_LAYER_ID, false);
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
