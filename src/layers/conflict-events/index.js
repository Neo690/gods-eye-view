import * as Cesium from 'cesium';
import { msg, t, tn } from '../../i18n/index.js';
import {
  CONFLICT_OVERLAY_SOURCE_ID,
  CONFLICT_OVERLAY_COHORT_LIMIT,
  CONFLICT_OVERLAY_COLLISION_CAPACITY,
  fatalityColor,
  fatalityPixelSize,
  createConflictOverlayEntry,
  mapAnalystRecord,
  selectConflictOverlayCohort,
} from './model.js';
export * from './model.js';
export { createConflictEventsSource } from './source.js';

/** Events listed in the readout card. */
const READOUT_LIMIT = 5;
/** Severity bands, in the order the legend states them. */
const SEVERITY_BANDS = [
  { label: msg('Incident'), fatalities: 0 },
  { label: msg('1–9 killed'), fatalities: 1 },
  { label: msg('10+ killed'), fatalities: 10 },
];

/** Own one conflict-event display and its refresh lifecycle. */
export function createConflictEventsLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Conflict events require a snapshot source');
  if (!overlayHost)
    throw new TypeError('Conflict events require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _rows = [];
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  const layer = {
    id: 'conflict-events',
    name: 'Conflict events (7d)',
    icon: '⚔️',
    source: 'ACLED',
    updateInterval: 600000,

    init(viewer) {
      if (_viewer)
        throw new Error('Conflict events layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('conflict-events');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _rows = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(CONFLICT_OVERLAY_SOURCE_ID, false);
      console.log('[Data:ConflictEvents] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(CONFLICT_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(CONFLICT_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(CONFLICT_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      // A manual read (the error line's retry) must work while the layer is
      // off: a failed enable leaves exactly that state. Only the data
      // source is required; overlays stay gated on _enabled below.
      if (!_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request) return false;

        const nextEntities = [];
        const overlayEntries = [];
        for (const row of rows) {
          const position = Cesium.Cartesian3.fromDegrees(row.lon, row.lat);
          const color = fatalityColor(row.fatalities);
          nextEntities.push(
            new Cesium.Entity({
              id: `conflict:${row.stableId}`,
              position,
              point: {
                pixelSize: fatalityPixelSize(row.fatalities),
                color,
                outlineColor: color.withAlpha(0.35),
                outlineWidth: 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
              properties: {
                lat: row.lat,
                lon: row.lon,
                timeMs: row.timeMs,
                type: row.type,
                subType: row.subType,
                actors: row.actors,
                fatalities: row.fatalities,
                country: row.country,
                provider: row.provider,
                sourceUrl: row.sourceUrl,
              },
            }),
          );
          overlayEntries.push(
            createConflictOverlayEntry({
              id: row.stableId,
              position,
              fatalities: row.fatalities,
              accent: color.toCssColorString(),
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        if (_enabled) {
          overlayHost.setEntries(
            CONFLICT_OVERLAY_SOURCE_ID,
            selectConflictOverlayCohort(overlayEntries),
            {
              cohortLimit: CONFLICT_OVERLAY_COHORT_LIMIT,
              collisionCapacity: CONFLICT_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _rows = rows;
        _count = nextEntities.length;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(`[Data:ConflictEvents] Updated: ${_count} events`);
        notify();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:ConflictEvents] Fetch error:', e);
        _lastError = e?.code || e?.message || msg('Conflict feed unavailable');
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    /**
     * Re-read the source now. The panel's error line calls this so an operator
     * who has just fixed ACLED_EMAIL/ACLED_PASSWORD does not have to reload the
     * page.
     * @returns {Promise<boolean>} true when the read succeeded.
     */
    refresh() {
      // A manual read is allowed while the layer is off: a failed enable
      // leaves exactly that state, and the error line retries from it.
      return this.update();
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      _rows = [];
      rowControlsListener = null;
      overlayHost.clearSource(CONFLICT_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(CONFLICT_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Readout descriptor for the Layers panel: the severity legend, the
     * coverage note, and the deadliest events currently held.
     *
     * `readout: true` renders the toggle and source line only; this card owns
     * the rest. Counts and errors stay English data and are translated here,
     * as the panel row does for every other layer.
     */
    /**
     * Deadliest events as list items, shared by the Layers row card and the
     * dedicated conflict window so the two surfaces cannot disagree.
     *
     * Sorted by toll, then by stable id so equal tolls keep one order.
     *
     * @param {number} [limit=50] Maximum items to project.
     * @returns {Array<{id: string, ordinal: number, lead: string, text: string, accent: string}>}
     */
    getRecentEvents(limit = 50) {
      const count = Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit))
        : 50;
      return _rows
        .slice()
        .sort(
          (a, b) =>
            (b.fatalities ?? 0) - (a.fatalities ?? 0) ||
            String(a.stableId).localeCompare(String(b.stableId)),
        )
        .slice(0, count)
        .map((row, index) => ({
          id: row.stableId,
          ordinal: index + 1,
          lead:
            row.fatalities > 0
              ? tn(row.fatalities, '{count} killed', '{count} killed')
              : t('Incident'),
          text: [row.type, row.country].filter(Boolean).join(' · '),
          accent: fatalityColor(row.fatalities).toCssColorString(),
        }));
    },

    /**
     * The last source error code the proxy reported (`no_key`, `auth`,
     * `unauthorized`, `upstream`, `unparseable`), or null when the last read
     * succeeded. Callers show it instead of guessing from an empty list.
     * @returns {string|null}
     */
    getLastError() {
      return _lastError;
    },

    getRowControls() {
      const statusText = _lastError
        ? msg(_lastError)
        : tn(_count, '{count} event', '{count} events');
      return {
        // NOT `readout: true`: that path hands the card to the weather readout
        // host and removes this row's own containers. The generic row renders
        // the legend inline and the list under the row, which is what these
        // two families need.
        info: `${t('ACLED')} · ${t('Last 7 days')} · ${statusText}`,
        legend: SEVERITY_BANDS.map((band) => ({
          color: fatalityColor(band.fatalities).toCssColorString(),
          label: t(band.label),
        })),
        legendCategorical: true,
        list: {
          ariaLabel: t('Deadliest conflict events'),
          items: this.getRecentEvents(READOUT_LIMIT),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        lastError: _lastError,
      };
    },

    /**
     * Snapshot displayed events as JSON-safe records for the analyst query
     * engine. On-demand only — zero per-frame cost, no listeners, no caching.
     * @param {number} [maxCount=2000] - Maximum records to return.
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const props = entity.properties?.getValue?.(Cesium.JulianDate.now());
        if (!props) continue;
        const raw = {
          id: String(entity.id).replace(/^conflict:/, ''),
          lat: props.lat,
          lon: props.lon,
          timeMs: props.timeMs,
          type: props.type,
          subType: props.subType,
          actors: props.actors,
          fatalities: props.fatalities,
          country: props.country,
          provider: props.provider,
          sourceUrl: props.sourceUrl,
        };
        result.push(mapAnalystRecord(raw, result.length));
      }
      return result;
    },

    getState() {
      return {
        id: layer.id,
        enabled: _enabled,
        count: _count,
        lastUpdate: _lastUpdate,
        lastError: _lastError,
      };
    },
  };

  return layer;
}
