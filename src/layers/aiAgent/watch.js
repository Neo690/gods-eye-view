// Sentinel watch engine.
//
// Listens to the data manager's layer lifecycle (snapshot updates, layer
// enable/disable, feed errors) and translates raw record changes into events:
// NEW / LOST / STATE / ERROR, each rate-bounded so one exploding feed cannot
// flood the overlay or the reports. Pure data: no DOM, no i18n — the overlay
// renders events and the report serializes them in the active language.

/** Severity ladder shared by the watchdog engine and the renderer. */
const SEVERITY_RANK = Object.freeze({ info: 0, warn: 1, emergency: 2 });

/**
 * The renderer's severity for one event, regardless of who produced it;
 * anything unmapped reads as calm info.
 */
export function eventSeverity(event) {
  const severity = event?.severity;
  return typeof severity === 'string' && severity in SEVERITY_RANK
    ? severity
    : 'info';
}

/** The worst severity across a batch; 'info' when the batch is empty. */
export function worstSeverity(events) {
  let worst = 'info';
  for (const event of events ?? []) {
    const severity = eventSeverity(event);
    if (SEVERITY_RANK[severity] > SEVERITY_RANK[worst]) worst = severity;
  }
  return worst;
}

/**
 * Resolve the renderer's severity for one raw engine kind. A vanished feed
 * or an error stream is a warning; fresh records escalate with magnitude.
 */
export function resolveSeverity(kind, { magnitude = null } = {}) {
  if (kind === 'lost' || kind === 'error') return 'warn';
  if (kind === 'new')
    return Number.isFinite(Number(magnitude)) && Number(magnitude) >= 5
      ? 'emergency'
      : 'warn';
  return 'info';
}

/**
 * The comparable surface of one lifecycle row: only what an update tick can
 * differ. A feed error surfaces whether it comes from source availability or
 * the manager's own refresh failure.
 */
export function readStrongRecord(row) {
  const stats = row?.stats ?? {};
  const error = stats.sourceUnavailable ? stats.error : stats.managerRefreshError;
  return {
    id: String(row?.id ?? ''),
    label: String(row?.name ?? row?.id ?? ''),
    enabled: row?.enabled === true,
    loading: stats.loading === true,
    count: Number.isFinite(Number(stats.count)) ? Number(stats.count) : 0,
    error:
      error == null || String(error).trim() === '' ? null : String(error).trim(),
  };
}

/**
 * One watchdog pass: diff lifecycle rows against the previous pass and
 * surface health/data events the avatar and the planner can act on.
 *
 * Mutates `state` in place (the layer keeps one state object across cycles):
 *   - `state.previous` (Map) is replaced with this pass's snapshots,
 *   - `state.seen` (Set) remembers ids whose first sight was already armed.
 *
 * The first sight of a layer only arms the baseline: startup noise never
 * floods the feed. A feed error escalates to 'warn'; a record-count change
 * to 'info'. Loading ticks carry no news value and are skipped.
 *
 * @param {Array<object>} rows lifecycle rows (the manager's getAll()).
 * @param {{previous?: Map<string, object>, seen?: Set<string>}} state memory.
 * @param {{now?: () => number, readRecords?: (row: object) => object}} [opts]
 * @returns {{events: Array<object>, previous: Map<string, object>}}
 */
export function watchLayers(
  rows,
  state = {},
  { now = Date.now, readRecords = readStrongRecord } = {},
) {
  const at = now();
  const events = [];
  const previous = new Map(state.previous ?? []);
  const seen = state.seen instanceof Set ? state.seen : new Set();

  for (const raw of rows ?? []) {
    const record = readRecords(raw);
    if (!record.id) continue;
    const before = previous.get(record.id) ?? null;
    previous.set(record.id, record);
    if (!before || !seen.has(record.id)) {
      seen.add(record.id);
      continue; // first sight arms the baseline
    }
    if (record.error && record.error !== before.error) {
      events.push(
        Object.freeze({
          kind: 'layer-error',
          layerId: record.id,
          label: record.label,
          detail: record.error,
          at,
          severity: 'warn',
        }),
      );
      continue;
    }
    if (record.loading || before.loading) continue;
    const delta = record.count - before.count;
    if (delta === 0) continue;
    seen.add(record.id);
    events.push(
      Object.freeze({
        kind: 'event-update',
        layerId: record.id,
        label: record.label,
        detail: `${delta > 0 ? '+' : '−'}${Math.abs(delta)}`,
        at,
        severity: 'info',
      }),
    );
  }
  return { events, previous };
}

/** How long a disappearance must hold before it is confirmed LOST. */
const GRACE_MS = 12000;

/** One event per dedup key within this window, so a stable feed stays silent. */
const DEDUP_MS = 120000;

/** No more than this many record ids are tracked per layer. */
const MAX_TRACKED_PER_LAYER = 20000;

/** Subjects at most carried verbatim on one burst event. */
const BURST_CAP = 20;

/** Stable identity fields per layer id, in order: the first present one wins. */
const RECORD_ID_RULES = Object.freeze({
  earthquakes: ['id', 'eventId'],
  'emsc-seismic': ['id', 'eventId'],
  radiation: ['id'],
  'space-weather': ['id'],
  'weather-cyclones': ['id', 'sid'],
  traffic: ['id'],
  'ais-live-vessels': ['mmsi', 'id'],
  flights: ['icao24', 'id'],
  military: ['icao24', 'id'],
  'railway-stations': ['id', 'stationId'],
  transit: ['id'],
  'fire-perimeters': ['id'],
  'local-firms': ['id'],
});

/** Magnitude-looking fields per layer, used to rank NEW alerts. */
const MAGNITUDE_FIELDS = Object.freeze({
  earthquakes: ['mag', 'magnitude'],
  'emsc-seismic': ['mag', 'magnitude'],
  radiation: ['cpm', 'value'],
  traffic: speedGuess(),
});

function speedGuess() {
  return ['speed', 'congestion'];
}

/** First magnitude-looking number on the record, or null. */
function magnitudeFor(layerId, record) {
  const fields = MAGNITUDE_FIELDS[layerId];
  if (!fields) return null;
  for (let i = 0; i < fields.length; i++) {
    const value = Number(record?.[fields[i]]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function magnitudeForRecord(layerId, record) {
  return magnitudeFor(layerId, record);
}

/** Highest magnitude among just-read rows, or null when the layer has none. */
function topMagnitude(layerId, rows) {
  let best = null;
  for (let i = 0; i < rows.length; i++) {
    const m = magnitudeForRecord(layerId, rows[i]);
    if (m != null && (best == null || m > best)) best = m;
  }
  return best;
}

/**
 * Sentinel watch engine over one data manager.
 *
 * The manager opt-in channels are consumed defensively: a manager that does
 * not carry them still yields a working engine (it just never emits), so a
 * fail-open state is never worse than a silent one.
 *
 * @param {object} options
 * @param {{onSnapshotUpdate?: Function, onLayerState?: Function,
 *   onLayerError?: Function}} options.dataManager the data manager to bind to.
 */
export function createSentinelWatch({ dataManager } = {}) {
  if (!dataManager || typeof dataManager !== 'object')
    throw new TypeError('A data manager to bind is required');

  /** Per-layer book of record ids: layerId -> { map: Map<id, ts> }. */
  const registry = new Map();
  const lastEventAt = new Map();
  const dedupKeys = new Map(); // key -> ts within DEDUP_MS
  const listeners = new Set();
  let bound = false;
  let destroyed = false;
  let attachable = null;

  const emit = (event) => {
    if (destroyed) return;
    for (const listener of listeners) {
      try {
        listener(Object.freeze(event));
      } catch (error) {
        console.warn('[aiAgent] watch listener failed:', error);
      }
    }
  };

  const eventId = () =>
    `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  /** Snap one event against its own recent self within DEDUP_MS. */
  function dedupAllow(key) {
    const now = Date.now();
    const prev = dedupKeys.get(key) || 0;
    if (now - prev < DEDUP_MS) return false;
    dedupKeys.set(key, now);
    if (dedupKeys.size > 4000) {
      for (const [k, ts] of dedupKeys)
        if (now - ts > 4 * DEDUP_MS) dedupKeys.delete(k);
    }
    return true;
  }

  function onSnapshotUpdate(payload) {
    if (destroyed) return;
    const layerId = String(payload?.layerId ?? '');
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (!layerId || !rows.length) return;

    const ts = Date.now();
    let book = registry.get(layerId);
    if (!book) {
      book = { map: new Map(), lastReadIds: null };
      registry.set(layerId, book);
    }
    const seenIds = new Set();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const fields = RECORD_ID_RULES[layerId];
      if (!fields) continue;
      for (let j = 0; j < fields.length; j++) {
        const value = row?.[fields[j]];
        if (value != null && value !== '') {
          seenIds.add(String(value));
          break;
        }
      }
    }

    const lostIds = book.lastReadIds
      ? [...book.lastReadIds].filter((id) => !seenIds.has(id))
      : [];
    const newIds = book.lastReadIds
      ? [...seenIds].filter((id) => !book.lastReadIds.has(id))
      : [];
    for (const id of seenIds) book.map.set(id, ts);
    if (book.map.size > MAX_TRACKED_PER_LAYER) {
      const cutoff = ts - GRACE_MS;
      for (const [id, seenAt] of book.map)
        if (seenAt < cutoff) book.map.delete(id);
    }

    if (lostIds.length) {
      if (dedupAllow(`lost:${layerId}:${lostIds.slice(0, 4).join(',')}`))
        emit({
          id: eventId(),
          kind: 'lost',
          layerId,
          ts,
          severity: resolveSeverity('lost'),
          count: lostIds.length,
          subjects: lostIds.slice(0, BURST_CAP),
        });
    }

    if (newIds.length) {
      const top = topMagnitude(layerId, rows);
      if (dedupAllow(`new:${layerId}:${newIds.length}:${Math.floor(ts / DEDUP_MS)}`))
        emit({
          id: eventId(),
          kind: 'new',
          layerId,
          ts,
          severity: resolveSeverity('new', { layerId, magnitude: top }),
          count: newIds.length,
          subjects: newIds.slice(0, BURST_CAP),
          ...(top != null ? { magnitude: top } : {}),
        });
    }

    book.lastReadIds = seenIds;
    book.lastRead = ts;
  }

  function onLayerState(payload) {
    if (destroyed) return;
    const layerId = String(payload?.layerId ?? '');
    if (!layerId) return;
    emit({
      id: eventId(),
      kind: 'state',
      layerId,
      enabled: payload?.enabled === true,
      ts: Date.now(),
      severity: resolveSeverity('state'),
    });
  }

  function onLayerError(payload) {
    if (destroyed) return;
    const layerId = String(payload?.layerId ?? '');
    if (!layerId) return;
    const message = String(payload?.error?.message ?? payload?.error ?? '');
    if (!dedupAllow(`error:${layerId}:${message}`)) return;
    emit({
      id: eventId(),
      kind: 'error',
      layerId,
      ts: Date.now(),
      severity: resolveSeverity('error'),
      message,
    });
  }

  /** Bind the engine to the data manager's channels, once. Returns the undo. */
  function bind() {
    if (bound || destroyed) return null;
    const removes = [];
    if (typeof dataManager.onSnapshotUpdate === 'function')
      removes.push(dataManager.onSnapshotUpdate(onSnapshotUpdate));
    if (typeof dataManager.onLayerState === 'function')
      removes.push(dataManager.onLayerState(onLayerState));
    if (typeof dataManager.onLayerError === 'function')
      removes.push(dataManager.onLayerError(onLayerError));
    bound = true;
    attachable = () => {
      for (const remove of removes) {
        try {
          remove?.();
        } catch {
          // A manager that is being torn down cannot accept another removal.
        }
      }
    };
    return attachable;
  }

  function destroy() {
    destroyed = true;
    try {
      attachable?.();
    } finally {
      attachable = null;
      bound = false;
      listeners.clear();
      registry.clear();
      dedupKeys.clear();
      lastEventAt.clear();
    }
  }

  return {
    addListener(fn) {
      if (destroyed || typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    bind,
    destroy,
  };
}

/** The engine's windows, exported so slowdowns can be verified against them. */
export const SENTINEL_WINDOWS = Object.freeze({ grace: GRACE_MS, dedup: DEDUP_MS });
