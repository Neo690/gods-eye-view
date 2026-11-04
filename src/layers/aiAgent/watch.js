// Sentinel watch engine.
//
// One pass compares the data-manager roster against the previous pass and
// turns what changed into events: a feed that starts failing, a record count
// that moved. The spider layer reads those events to decide where to walk, so
// this module is pure data — no DOM, no i18n, no clock of its own (the caller
// passes `now`), which lets a test pin a whole patrol cycle.

/** Severity ladder shared by the watch engine and the renderer. */
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
 * The comparable surface of one lifecycle row: only what an update tick can
 * differ. A feed error surfaces whether it comes from source availability or
 * the manager's own refresh failure.
 */
export function readStrongRecord(row) {
  const stats = row?.stats ?? {};
  const error = stats.sourceUnavailable
    ? stats.error
    : stats.managerRefreshError;
  return {
    id: String(row?.id ?? ''),
    label: String(row?.name ?? row?.id ?? ''),
    enabled: row?.enabled === true,
    loading: stats.loading === true,
    count: Number.isFinite(Number(stats.count)) ? Number(stats.count) : 0,
    error:
      error == null || String(error).trim() === ''
        ? null
        : String(error).trim(),
  };
}

/**
 * One watchdog pass: diff lifecycle rows against the previous pass and
 * surface health/data events the spider and the report card can act on.
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
