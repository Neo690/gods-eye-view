import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  ORBIT_CHANGE_BASELINE_STORAGE_KEY,
  baselineFromCatalog,
  orbitalChanges,
} from '../orbitChanges/model.js';
import {
  SATELLITE_WATCH_BASELINE_KEY,
  SATELLITE_WATCH_LAYER_ID,
  WATCH_SOURCE_CAPS,
  WATCH_SOURCES,
  conjunctionsFromCdm,
  createConjunctionDetailEntry,
  createConjunctionLabelEntry,
  createWatchLabelEntry,
  fromCatalogEntries,
  fromN2yoAbove,
  fromSpaceTrackGp,
  fromTleApiMembers,
  missingSecondaryNorads,
  parseCdmMessage,
  watchSummary,
} from './model.js';
export * from './model.js';
export { createSatelliteWatchSource } from './sources.js';

/** How long an inferred manoeuvre stays on the globe. */
const EVENT_TTL_MS = 24 * 3600 * 1000;

/** What each switch reads, marked for translation at its call site. */
const SOURCE_DETAILS = Object.freeze({
  azmth: msg('CelesTrak element sets · the flux azmth.space runs on'),
  'orbital-radar': msg('orbit changes inferred from successive element sets'),
  'war-monitor': msg(
    'public TLE catalogue · the satellite flux warmonitor.app runs on',
  ),
  'space-track': msg(
    'official element sets and the public conjunction feed · your Space-Track account',
  ),
  n2yo: msg('N2YO API · above the view centre, with your key'),
});

/** Ambient labels: the costliest inferred changes only. */
const LABEL_LIMIT = 12;
/** N2YO's free tier allows 1 000 calls an hour; five minutes is 12. */
const UPDATE_MS = 300_000;

/** Prefix of the conjunction marker entities this layer owns on the scene. */
const CONJUNCTION_ENTITY_PREFIX = 'satwatch:conjunction:';

/**
 * The click handler a browser installs. Kept behind an option so a host
 * without a canvas (the unit tests) can inject one instead of a viewer.
 * @param {object} viewer Cesium viewer.
 * @returns {object} Something with setInputAction/destroy.
 */
function defaultEventHandlerFactory(viewer) {
  return new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
}

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

function readBaseline(storage) {
  if (!storage?.getItem) return null;
  try {
    const raw = storage.getItem(SATELLITE_WATCH_BASELINE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.objects && typeof parsed.objects === 'object'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeBaseline(storage, baseline) {
  if (!storage?.setItem) return;
  try {
    storage.setItem(SATELLITE_WATCH_BASELINE_KEY, JSON.stringify(baseline));
  } catch {
    // A full store costs the next session its comparison, never this one.
  }
}

/**
 * The Orbit Changes layer keeps a previous element-set reading of its own in
 * the same browser. Reading it costs nothing and never removes it, so a first
 * session on a server whose cache has not refreshed yet still has a real
 * earlier observation to compare against. Shape-checked like our own key.
 */
function readOrbitBaseline(storage) {
  if (!storage?.getItem) return null;
  try {
    const raw = storage.getItem(ORBIT_CHANGE_BASELINE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.objects && typeof parsed.objects === 'object'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * One satellite layer with four independently switchable sources: Azmth and
 * War Monitor read the public element-set flux those applications are built on,
 * Orbital Radar reads the same successive-element-set diff its tracker performs,
 * and N2YO reads its own API with the operator's key.
 *
 * A source that fails never takes the others down: each has its own error slot,
 * its own count, and its own switch.
 *
 * @param {object} options
 * @param {{readCatalog: Function, readTleApi: Function, readN2yo: Function}} options.source
 * @param {object} [options.overlayHost]
 * @param {object|null} [options.storage]
 * @param {Function} [options.now]
 */
export function createSatelliteWatchLayer({
  source,
  overlayHost = null,
  storage,
  now = () => Date.now(),
  eventHandlerFactory = defaultEventHandlerFactory,
} = {}) {
  if (typeof source?.readCatalog !== 'function')
    throw new TypeError('Satellite watch requires a catalog source');
  if (typeof source?.readTleApi !== 'function')
    throw new TypeError('Satellite watch requires a TLE catalogue source');
  if (typeof source?.readN2yo !== 'function')
    throw new TypeError('Satellite watch requires an N2YO source');
  if (overlayHost != null && !overlayHost.setEntries)
    throw new TypeError('Satellite watch overlay host must publish entries');

  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  const _store = storage === undefined ? readDefaultStorage() : storage;
  /** source id -> objects */
  let _objects = new Map();
  /** source id -> error text */
  let _errors = new Map();
  /** The switches that are on. All four start on; N2YO says when it has no key. */
  const _on = new Set(WATCH_SOURCES.map((entry) => entry.id));
  /** norad -> inferred manoeuvre (Orbital Radar). */
  let _events = new Map();
  /** Space-Track conjunctions, already placed at their close approach. */
  let _conjunctions = [];
  /** The conjunction whose detail card is open, by event id. */
  let _selectedConjunctionId = null;
  /** The click handler, while the layer is enabled. */
  let _clickHandler = null;
  /** True while the Space-Track element sets being shown are a cached copy. */
  let _spaceTrackStale = false;
  /** Why a keyed source answers nothing, when that is the answer. */
  let _n2yoNote = null;
  let _spaceTrackNote = null;
  /** True until the Orbital Radar source has a previous element set to diff. */
  let _radarAwaitingBaseline = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  /** Bumped per refresh, so a slow source cannot paint into a newer one. */
  let _run = 0;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  const centre = () => {
    const camera = _viewer?.camera?.positionCartographic;
    if (!camera) return { lat: 0, lon: 0 };
    const lat = Cesium.Math.toDegrees(camera.latitude);
    const lon = Cesium.Math.toDegrees(camera.longitude);
    return Number.isFinite(lat) && Number.isFinite(lon)
      ? { lat, lon }
      : { lat: 0, lon: 0 };
  };

  const liveEvents = () => {
    const cutoff = now() - EVENT_TTL_MS;
    const events = [];
    for (const [norad, event] of _events) {
      if (event.observedAt < cutoff) _events.delete(norad);
      else events.push(event);
    }
    return events.sort((a, b) => b.priority - a.priority);
  };

  const counts = () => {
    const out = {};
    for (const source of WATCH_SOURCES) {
      out[source.id] = _on.has(source.id)
        ? (_objects.get(source.id) || []).length
        : 0;
    }
    out['orbital-radar'] = _on.has('orbital-radar') ? liveEvents().length : 0;
    return out;
  };

  const render = () => {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();
    let painted = 0;
    for (const source of WATCH_SOURCES) {
      if (!_on.has(source.id)) continue;
      if (source.id === 'orbital-radar') continue;
      const colour = Cesium.Color.fromCssColorString(source.color);
      for (const object of _objects.get(source.id) || []) {
        _dataSource.entities.add(
          new Cesium.Entity({
            id: `satwatch:${object.id}`,
            position: Cesium.Cartesian3.fromDegrees(
              object.lon,
              object.lat,
              object.altitudeKm * 1000,
            ),
            point: {
              pixelSize: 4,
              color: colour,
              // No clamp: a satellite is drawn where it is, not on the ground.
              heightReference: Cesium.HeightReference.NONE,
            },
            properties: {
              source: object.source,
              satellite: object.name,
              regime: object.regime,
              altitudeKm: object.altitudeKm,
            },
          }),
        );
        painted++;
      }
    }

    const events = _on.has('orbital-radar') ? liveEvents() : [];
    for (const event of events) {
      _dataSource.entities.add(
        new Cesium.Entity({
          id: `satwatch:orbital-radar:${event.norad}`,
          position: Cesium.Cartesian3.fromDegrees(event.lon, event.lat),
          point: {
            pixelSize: 8,
            color: Cesium.Color.fromCssColorString('#F6AD55'),
            outlineColor: Cesium.Color.fromCssColorString('#08161c'),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.NONE,
          },
          properties: {
            source: 'orbital-radar',
            satellite: event.name,
            deltaVMps: event.deltaVMps,
            deltaAltitudeKm: event.deltaAltitudeKm,
          },
        }),
      );
      painted++;
    }

    // Space-Track conjunctions: the primary at its close-approach point, ringed
    // so a predicted miss reads differently from a present position.
    const conjunctions = _on.has('space-track') ? _conjunctions : [];
    for (const event of conjunctions) {
      _dataSource.entities.add(
        new Cesium.Entity({
          id: `satwatch:conjunction:${event.id}`,
          position: Cesium.Cartesian3.fromDegrees(
            event.lon,
            event.lat,
            event.altitudeKm * 1000,
          ),
          point: {
            pixelSize: 9,
            color: Cesium.Color.fromCssColorString('#B794F4'),
            outlineColor: Cesium.Color.fromCssColorString('#08161c'),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.NONE,
          },
          properties: {
            source: 'space-track',
            satellite: event.name,
            secondary: event.secondaryName,
            tca: event.tca,
            minRangeKm: event.minRangeKm,
            pc: event.pc,
          },
        }),
      );
      painted++;
    }

    _count = painted;
    if (!overlayHost) return;
    // Conjunction labels come first: a predicted close approach is the rarest
    // and most consequential thing this layer knows. The one the operator
    // clicked comes before even those, and is the only one that carries the
    // whole card, because it is the answer to that click.
    const entries = [];
    const selected = conjunctions.find(
      (event) => event.id === _selectedConjunctionId,
    );
    if (selected) {
      entries.push(
        createConjunctionDetailEntry(
          selected,
          Cesium.Cartesian3.fromDegrees(
            selected.lon,
            selected.lat,
            selected.altitudeKm * 1000,
          ),
          t,
        ),
      );
    }
    entries.push(
      ...conjunctions
        .filter((event) => event.id !== _selectedConjunctionId)
        .slice(0, Math.max(0, LABEL_LIMIT - entries.length))
        .map((event) =>
          createConjunctionLabelEntry(
            event,
            Cesium.Cartesian3.fromDegrees(
              event.lon,
              event.lat,
              event.altitudeKm * 1000,
            ),
            t,
          ),
        ),
    );
    const left = Math.max(0, LABEL_LIMIT - entries.length);
    entries.push(
      ...events
        .slice(0, left)
        .map((event) =>
          createWatchLabelEntry(
            event,
            Cesium.Cartesian3.fromDegrees(event.lon, event.lat),
            t,
          ),
        ),
    );
    overlayHost.setEntries(SATELLITE_WATCH_LAYER_ID, entries, {
      cohortLimit: LABEL_LIMIT,
      moving: false,
    });
  };

  /**
   * The conjunction a scene pick landed on, or null.
   *
   * A Cesium entity pick surfaces the Entity itself rather than an id string,
   * so the marker's own id lives one level in; a primitive pick puts it on
   * `picked.id`. Both shapes are read, because which one arrives depends on
   * the pick path.
   * @param {*} picked Result of `scene.pick()`.
   * @returns {?string} The conjunction's event id.
   */
  const conjunctionIdFromPick = (picked) => {
    const raw = picked?.id ?? picked?.primitive?.id;
    const id = typeof raw === 'string' ? raw : raw?.id;
    if (typeof id !== 'string') return null;
    return id.startsWith(CONJUNCTION_ENTITY_PREFIX)
      ? id.slice(CONJUNCTION_ENTITY_PREFIX.length)
      : null;
  };

  /**
   * Open one conjunction's detail card, or close it with null.
   *
   * A card is only ever opened for an event this layer currently holds: a
   * stale id from the previous poll would draw a marker that no longer exists.
   * @param {?string} id Conjunction event id.
   */
  const selectConjunction = (id) => {
    const next =
      id && _conjunctions.some((event) => event.id === id) ? id : null;
    if (next === _selectedConjunctionId) return;
    _selectedConjunctionId = next;
    render();
  };

  /**
   * Click behaviour, enable-time only: a conjunction marker opens its card,
   * empty space closes it, and another layer's entity is left alone so this
   * handler never fights that layer's own selection.
   * @param {{position: {x: number, y: number}}} click
   */
  const onSceneClick = (click) => {
    // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
    if (!_enabled || !isPointerFree()) return;
    const picked = _viewer?.scene?.pick?.(click?.position);
    const conjunctionId = conjunctionIdFromPick(picked);
    if (conjunctionId) {
      selectConjunction(conjunctionId);
      return;
    }
    if (picked) return;
    if (_selectedConjunctionId) selectConjunction(null);
  };

  const installClickHandler = () => {
    if (_clickHandler || !_viewer) return;
    let handler = null;
    try {
      handler = eventHandlerFactory(_viewer);
    } catch {
      // No canvas to bind (a headless host): the layer still paints, it just
      // has no click to answer.
      return;
    }
    if (typeof handler?.setInputAction !== 'function') return;
    handler.setInputAction(
      onSceneClick,
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );
    _clickHandler = handler;
  };

  const removeClickHandler = () => {
    _clickHandler?.destroy?.();
    _clickHandler = null;
  };

  /**
   * A session's first reference, when this browser has never stored one: the
   * element sets the proxy cache replaced on its last refresh. Without it the
   * first poll can only record a baseline, so Orbital Radar paints nothing
   * until the poll after — which is what made the switch look broken.
   */
  const seedBaselineFromCache = async (signal) => {
    if (typeof source.readPreviousCatalog !== 'function') return null;
    const cached = await source.readPreviousCatalog({ signal });
    if (!cached?.entries?.length) return null;
    const seeded = baselineFromCatalog(cached.entries, now());
    writeBaseline(_store, seeded);
    return seeded;
  };

  const refreshAzmth = async (signal, date) => {
    const catalog = await source.readCatalog({ signal });
    _objects.set(
      'azmth',
      fromCatalogEntries(catalog.entries, date, WATCH_SOURCE_CAPS.azmth),
    );
    // Orbital Radar diffs the same catalogue, so it is compared here rather
    // than fetched twice.
    if (!_on.has('orbital-radar')) return;
    const stored = readBaseline(_store);
    const previous =
      stored ||
      (await seedBaselineFromCache(signal)) ||
      readOrbitBaseline(_store);
    const next = baselineFromCatalog(catalog.entries, now());
    if (!previous) {
      writeBaseline(_store, next);
      _radarAwaitingBaseline = true;
      return;
    }
    _radarAwaitingBaseline = false;
    const observedAt = now();
    for (const event of orbitalChanges(previous, catalog.entries)) {
      _events.set(event.norad, { ...event, observedAt });
    }
    writeBaseline(_store, next);
  };

  const refreshWarMonitor = async (signal, date) => {
    const payload = await source.readTleApi({ signal });
    _objects.set(
      'war-monitor',
      fromTleApiMembers(
        payload.members,
        date,
        WATCH_SOURCE_CAPS['war-monitor'],
      ),
    );
  };

  const refreshN2yo = async (signal) => {
    const { lat, lon } = centre();
    const answer = await source.readN2yo({ lat, lon, signal });
    if (!answer.ok) {
      _n2yoNote =
        answer.error === 'missing-key'
          ? t('Needs an API key')
          : translateFeedError(answer.error);
      _objects.set('n2yo', []);
      return;
    }
    _n2yoNote = null;
    _objects.set(
      'n2yo',
      fromN2yoAbove({ above: answer.above, at: now() }, WATCH_SOURCE_CAPS.n2yo),
    );
  };

  const refreshSpaceTrack = async (signal, date) => {
    const answer = await source.readSpaceTrack({ signal });
    if (!answer.ok) {
      _spaceTrackNote = t('Needs an account');
      _spaceTrackStale = false;
      _objects.set('space-track', []);
      _conjunctions = [];
      return;
    }
    _spaceTrackNote = null;
    _spaceTrackStale = Boolean(answer.stale);
    _objects.set(
      'space-track',
      fromSpaceTrackGp(answer.entries, date, WATCH_SOURCE_CAPS['space-track']),
    );
    // One CDM can arrive several times as it is refined; the newest row for an
    // event is the one worth placing, which the feed's own ordering gives.
    const seen = new Set();
    const messages = [];
    for (const raw of answer.messages || []) {
      const message = parseCdmMessage(raw);
      if (!message || seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }
    // A CDM does not publish the closing rate, and the GP window never holds
    // the debris a conjunction is against, so the pair is completed from the
    // cached per-object route before the events are placed.
    let entries = answer.entries;
    const wanted = missingSecondaryNorads(entries, messages);
    if (wanted.length && source.readElementSets) {
      try {
        const extra = await source.readElementSets(wanted, { signal });
        if (extra.entries.length) entries = [...entries, ...extra.entries];
      } catch {
        // Without the secondaries the events still place; their card says the
        // closing rate is unavailable.
      }
    }
    _conjunctions = conjunctionsFromCdm(
      messages,
      entries,
      WATCH_SOURCE_CAPS['orbital-radar'],
    );
    // A card whose event the new read no longer carries would keep describing
    // a conjunction that is gone, so the selection is dropped with it.
    if (
      _selectedConjunctionId &&
      !_conjunctions.some((event) => event.id === _selectedConjunctionId)
    ) {
      _selectedConjunctionId = null;
    }
  };

  const layer = {
    id: SATELLITE_WATCH_LAYER_ID,
    name: 'Satellite Watch',
    icon: '📡',
    source: 'CelesTrak · TLE catalogue · N2YO',
    updateInterval: UPDATE_MS,

    init(viewer) {
      if (_viewer) throw new Error('Satellite watch is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(SATELLITE_WATCH_LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _objects = new Map();
      _errors = new Map();
      _events = new Map();
      _conjunctions = [];
      _selectedConjunctionId = null;
      _spaceTrackStale = false;
      _n2yoNote = null;
      _spaceTrackNote = null;
      _radarAwaitingBaseline = false;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _run = 0;
      overlayHost?.setVisible(SATELLITE_WATCH_LAYER_ID, false);
      console.log('[Data:SatelliteWatch] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible(SATELLITE_WATCH_LAYER_ID, true);
      installClickHandler();
      notify();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      _selectedConjunctionId = null;
      removeClickHandler();
      if (_dataSource) {
        _dataSource.show = false;
        _dataSource.entities.removeAll();
      }
      overlayHost?.clearSource(SATELLITE_WATCH_LAYER_ID);
      overlayHost?.setVisible(SATELLITE_WATCH_LAYER_ID, false);
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const run = ++_run;
      const date = new Date(now());
      _errors = new Map();
      try {
        // Each source is independent: a refused key or a dead catalogue costs
        // its own switch, never the others. They run together as well, because
        // the TLE catalogue answers in about twelve seconds while CelesTrak is
        // already warm — serialising them would make the whole layer look
        // stuck for that long.
        const guard = async (key, fallback, task) => {
          try {
            await task();
          } catch (error) {
            if (request.signal.aborted) return;
            _errors.set(key, error?.message || fallback);
          }
        };
        const jobs = [];
        if (_on.has('azmth') || _on.has('orbital-radar')) {
          jobs.push(
            guard('azmth', msg('Catalogue unavailable'), () =>
              refreshAzmth(request.signal, date),
            ),
          );
        }
        if (_on.has('n2yo')) {
          jobs.push(
            guard('n2yo', msg('N2YO unavailable'), () =>
              refreshN2yo(request.signal),
            ),
          );
        }
        await Promise.all(jobs);
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        render();
        _lastUpdate = now();
        _lastError = null;
        notify();
        // The TLE catalogue answers in 5–12 s a page, and Space-Track answers
        // one authenticated multi-megabyte read. Waiting for either inside this
        // update would hold the whole layer — and the panel's toggle — for that
        // long, so the fast sources paint first and the slow ones fold in when
        // they land, unless a newer refresh has already replaced them.
        const deferred = [];
        if (_on.has('war-monitor')) {
          deferred.push(
            guard('war-monitor', msg('TLE catalogue unavailable'), () =>
              refreshWarMonitor(request.signal, date),
            ),
          );
        }
        if (_on.has('space-track')) {
          deferred.push(
            guard('space-track', msg('Space-Track unavailable'), () =>
              refreshSpaceTrack(request.signal, date),
            ),
          );
        }
        if (deferred.length) {
          void Promise.all(deferred).then(() => {
            if (request.signal.aborted || run !== _run || !_enabled) return;
            render();
            _lastUpdate = now();
            notify();
          });
        }
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _lastError = error?.message || msg('Satellite sources unavailable');
        console.warn('[Data:SatelliteWatch] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },

    /**
     * The four switches, their counts, and why a switch is empty. A source with
     * no objects still shows its switch, because the switch is the answer to
     * "which of these am I reading".
     */
    getRowControls() {
      const current = counts();
      const total = Object.values(current).reduce((sum, n) => sum + n, 0);
      return {
        info: watchSummary(current, total, t('Objects tracked')) || undefined,
        infoTitle: _lastError ? translateFeedError(_lastError) : undefined,
        networks: {
          ordered: false,
          ariaLabel: t('Satellite sources'),
          items: WATCH_SOURCES.map((entry) => {
            const on = _on.has(entry.id);
            const count = current[entry.id] || 0;
            const notes = [t(SOURCE_DETAILS[entry.id] || entry.label)];
            notes.push(
              `${t(on ? 'Shown' : 'Hidden')} · ${t('Objects: {count}', { count })}`,
            );
            const error = _errors.get(entry.id);
            if (error) notes.push(translateFeedError(error));
            if (entry.id === 'n2yo' && on && _n2yoNote) notes.push(_n2yoNote);
            if (entry.id === 'space-track' && on) {
              if (_spaceTrackNote) notes.push(_spaceTrackNote);
              if (_spaceTrackStale) notes.push(t('Cached element sets'));
              if (_conjunctions.length)
                notes.push(
                  t('Conjunctions: {count}', { count: _conjunctions.length }),
                );
            }
            if (entry.id === 'orbital-radar' && on && _radarAwaitingBaseline)
              notes.push(t('Baseline recorded'));
            return {
              id: entry.id,
              text: count ? `${entry.label} · ${count}` : entry.label,
              checked: on,
              title: notes.join(' · '),
              onClick: () => {
                if (on) {
                  _on.delete(entry.id);
                  render();
                  notify();
                  return;
                }
                _on.add(entry.id);
                render();
                notify();
                // A source that was off has no data yet: turn the switch on
                // and fetch it now rather than waiting for the next poll.
                void layer.update?.();
              },
            };
          }),
        },
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
      const rows = [];
      for (const source of WATCH_SOURCES) {
        if (!_on.has(source.id)) continue;
        for (const object of _objects.get(source.id) || []) {
          rows.push({
            layerId: SATELLITE_WATCH_LAYER_ID,
            source: object.source,
            id: object.id,
            name: object.name,
            regime: object.regime,
            lat: object.lat,
            lon: object.lon,
            altitudeKm: object.altitudeKm,
          });
          if (rows.length >= limit) return rows;
        }
      }
      for (const event of _on.has('orbital-radar') ? liveEvents() : []) {
        rows.push({
          layerId: SATELLITE_WATCH_LAYER_ID,
          source: 'orbital-radar',
          id: event.norad,
          name: event.name,
          regime: null,
          lat: event.lat,
          lon: event.lon,
          deltaVMps: event.deltaVMps,
        });
        if (rows.length >= limit) return rows;
      }
      for (const event of _on.has('space-track') ? _conjunctions : []) {
        rows.push({
          layerId: SATELLITE_WATCH_LAYER_ID,
          source: 'space-track',
          id: event.id,
          name: event.name,
          regime: null,
          lat: event.lat,
          lon: event.lon,
          altitudeKm: event.altitudeKm,
          conjunctionWith: event.secondaryName,
          tca: event.tca,
          minRangeKm: event.minRangeKm,
          pc: event.pc,
          // Null when neither the feed nor the element sets gave a rate.
          relativeSpeedKmS: event.relativeSpeedKmS,
          relativeSpeedSource: event.relativeSpeedSource,
        });
        if (rows.length >= limit) return rows;
      }
      return rows;
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removeClickHandler();
      _viewer = null;
      _enabled = false;
      _selectedConjunctionId = null;
      _objects = new Map();
      _errors = new Map();
      _events = new Map();
      _conjunctions = [];
      _spaceTrackStale = false;
      _spaceTrackNote = null;
      _radarAwaitingBaseline = false;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      rowControlsListener = null;
      overlayHost?.clearSource(SATELLITE_WATCH_LAYER_ID);
      overlayHost?.setVisible(SATELLITE_WATCH_LAYER_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
    },
  };
  return layer;
}
