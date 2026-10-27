/**
 * Alert centre — the alerts agent's surface and delivery.
 *
 * The detector (src/data/incidentScan.js) says what is currently true; this
 * module watches it, keeps each incident for a while after it stops being
 * reported, turns arrivals into toasts and renders the list behind the HUD
 * bell. The button lives beside the language picker in #corner-actions.
 *
 * What it does NOT do: fetch. The scan reads the analyst records of the layers
 * the operator has already turned on, so a phone with no data on has nothing
 * to report — hence the note in the panel. A layer that is off reports no
 * records, and its incidents simply expire.
 *
 * Delivery rules, so a busy world does not spam the screen:
 *  - the first scan is a baseline: it fills the list silently, so opening the
 *    app does not announce yesterday's fires;
 *  - an id is announced once — while it stays reported it is not repeated, and
 *    if it clears and comes back it is new again;
 *  - one toast per scan: a single arrival is named, several are counted, so a
 *    burst cannot bury the screen in notifications;
 *  - a dismissed incident stays dismissed for DISMISS_TTL_MS, across reloads.
 *
 * The pure parts (IncidentFeed, localizeIncident) are exported for tests; the
 * mount function is the only DOM code.
 */
import { formatNumber, formatRelativeTime, t } from '../i18n/index.js';
import { INCIDENT_SEVERITY, scanIncidents } from '../data/incidentScan.js';
import { layerNameForId } from './layerNames.js';

/** An incident stays listed this long after the last scan that reported it. */
export const INCIDENT_RETAIN_MS = 15 * 60 * 1000;
/** Dismissals outlive a reload but not the day they were made. */
export const DISMISS_TTL_MS = 24 * 60 * 60 * 1000;
/** Keep storage bounded: oldest dismissals go first. */
export const MAX_DISMISSALS = 200;
export const SCAN_INTERVAL_MS = 45 * 1000;
/** Give the first layers time to land before the baseline scan. */
export const FIRST_SCAN_DELAY_MS = 12 * 1000;

const DISMISSED_STORAGE_KEY = 'gev.alerts.dismissed';

/**
 * The live incident list: what the scan last reported, plus a retention
 * window so a one-poll gap (a layer refreshing) does not flicker an alert away.
 */
export class IncidentFeed {
  /**
   * @param {{now?: () => number, retainMs?: number}} [options]
   */
  constructor({ now = () => Date.now(), retainMs = INCIDENT_RETAIN_MS } = {}) {
    this._now = now;
    this._retainMs = retainMs;
    /** @type {Map<string, {incident: object, firstSeenAt: number, lastSeenAt: number}>} */
    this._entries = new Map();
    /** @type {Map<string, number>} id → dismissal time */
    this._dismissed = new Map();
  }

  /**
   * Replace the reported set and return the ids that are new since last time.
   * @param {Array<object>} incidents
   * @param {number} [at]
   * @returns {Array<object>} The newly listed incidents, in scan order.
   */
  update(incidents, at = this._now()) {
    const added = [];
    for (const incident of incidents) {
      if (!incident?.id) continue;
      const existing = this._entries.get(incident.id);
      if (existing) {
        existing.incident = incident;
        existing.lastSeenAt = at;
        continue;
      }
      this._entries.set(incident.id, {
        incident,
        firstSeenAt: at,
        lastSeenAt: at,
      });
      added.push(incident);
    }
    this._expire(at);
    return added;
  }

  /** Drop entries the scan has not reported for `retainMs`, and stale dismissals. */
  _expire(at) {
    for (const [id, entry] of this._entries) {
      if (at - entry.lastSeenAt > this._retainMs) this._entries.delete(id);
    }
    for (const [id, dismissedAt] of this._dismissed) {
      if (at - dismissedAt > DISMISS_TTL_MS) this._dismissed.delete(id);
    }
  }

  /**
   * Hide one incident until it clears (and `DISMISS_TTL_MS` has passed).
   * @param {string} id
   * @param {number} [at]
   */
  dismiss(id, at = this._now()) {
    if (!id) return;
    this._dismissed.set(id, at);
    while (this._dismissed.size > MAX_DISMISSALS) {
      const oldest = this._dismissed.keys().next().value;
      this._dismissed.delete(oldest);
    }
  }

  /**
   * Hide all active incidents until they clear (and `DISMISS_TTL_MS` has passed).
   * @param {number} [at]
   */
  dismissAll(at = this._now()) {
    for (const id of this._entries.keys()) {
      this._dismissed.set(id, at);
    }
    while (this._dismissed.size > MAX_DISMISSALS) {
      const oldest = this._dismissed.keys().next().value;
      this._dismissed.delete(oldest);
    }
  }

  /** @param {string} id */
  isDismissed(id) {
    return this._dismissed.has(id);
  }

  /** Dismissals as plain entries, newest last, for storage. */
  dismissedEntries() {
    return [...this._dismissed];
  }

  /** Re-add dismissals read back from storage. */
  restoreDismissals(entries, at = this._now()) {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;
      const [id, dismissedAt] = entry;
      if (typeof id !== 'string' || !id) continue;
      if (!Number.isFinite(dismissedAt)) continue;
      if (at - dismissedAt > DISMISS_TTL_MS) continue;
      this._dismissed.set(id, dismissedAt);
    }
    while (this._dismissed.size > MAX_DISMISSALS) {
      const oldest = this._dismissed.keys().next().value;
      this._dismissed.delete(oldest);
    }
  }

  /** Listed incidents, most severe first, without the dismissed ones. */
  items() {
    return [...this._entries.values()]
      .filter((entry) => !this._dismissed.has(entry.incident.id))
      .map((entry) => entry.incident);
  }

  /** How many incidents the bell badge shows. */
  get size() {
    return this.items().length;
  }
}

/**
 * Resolve a message param: numbers through the locale, `{ messageKey }`
 * wrappers through `t()`, everything else as-is.
 * @param {object} params
 * @returns {Record<string, unknown>}
 */
export function resolveIncidentParams(params = {}) {
  const resolved = {};
  for (const [name, value] of Object.entries(params)) {
    if (value && typeof value === 'object' && 'messageKey' in value) {
      resolved[name] = t(value.messageKey);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      resolved[name] = formatNumber(value, { maximumFractionDigits: 1 });
    } else {
      resolved[name] = value;
    }
  }
  return resolved;
}

/**
 * The English template of an incident rendered in the active language.
 * @param {{title: {key: string, params?: object}, detail?: {key: string, params?: object}|null}} incident
 * @returns {{title: string, detail: string|null}}
 */
export function localizeIncident(incident) {
  const title = incident?.title
    ? t(incident.title.key, resolveIncidentParams(incident.title.params))
    : '';
  const detail = incident?.detail
    ? t(incident.detail.key, resolveIncidentParams(incident.detail.params))
    : null;
  return { title, detail };
}

/**
 * What one scan's arrivals are announced as: the single incident's own title,
 * or how many arrived when there are several. Null when nothing is new.
 * @param {Array<object>} incidents
 * @returns {string|null}
 */
export function announceText(incidents) {
  if (!incidents.length) return null;
  if (incidents.length === 1) return localizeIncident(incidents[0]).title;
  return t('{count} new alerts', { count: incidents.length });
}

/** The bell's accessible name, count included. */
export function alertButtonLabel(count) {
  return count > 0 ? t('Alerts: {count}', { count }) : t('Alerts');
}

/**
 * When an incident happened, read for a list row: relative under two hours,
 * else a local clock time, else nothing.
 * @param {number|null} atMs
 * @param {number} now
 * @returns {string}
 */
export function incidentTimeText(atMs, now) {
  if (!Number.isFinite(atMs) || atMs <= 0) return '';
  const minutes = Math.round((atMs - now) / 60000);
  if (Math.abs(minutes) < 120) return formatRelativeTime(minutes, 'minute');
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(atMs));
}

function readDismissed(storage) {
  try {
    const raw = storage?.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeDismissed(storage, entries) {
  try {
    storage?.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // storage unavailable: dismissals live for this page only
  }
}

/** The DOM the bell needs, built once. */
function buildMarkup(doc, ids) {
  const wrap = doc.createElement('div');
  wrap.className = 'alert-center';

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'alert-center-button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', ids.popup);
  button.title = t('Alerts');
  const bell = doc.createElement('span');
  bell.className = 'alert-center-bell';
  bell.setAttribute('aria-hidden', 'true');
  bell.textContent = '⚑';
  const badge = doc.createElement('span');
  badge.className = 'alert-center-badge';
  badge.hidden = true;
  button.append(bell, badge);

  const popup = doc.createElement('div');
  popup.className = 'alert-center-popup';
  popup.id = ids.popup;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-labelledby', ids.heading);
  popup.hidden = true;

  const header = doc.createElement('div');
  header.className = 'alert-center-header';
  const heading = doc.createElement('div');
  heading.className = 'alert-center-heading';
  heading.id = ids.heading;
  heading.textContent = t('Alerts');

  const purge = doc.createElement('button');
  purge.type = 'button';
  purge.className = 'alert-center-purge';
  purge.setAttribute('aria-label', t('Purge all alerts'));
  purge.title = t('Purge all alerts');
  purge.textContent = t('Purge');
  purge.hidden = true;
  header.append(heading, purge);

  const note = doc.createElement('p');
  note.className = 'alert-center-note';
  note.textContent = t('Only the layers you have turned on are watched.');
  const list = doc.createElement('ul');
  list.className = 'alert-center-list';
  const empty = doc.createElement('p');
  empty.className = 'alert-center-empty';
  empty.textContent = t('No active incident.');
  popup.append(header, note, list, empty);
  wrap.append(button, popup);
  return { wrap, button, badge, popup, list, empty, purge };
}

/**
 * Mount the alert centre into a container (usually #alert-center).
 *
 * @param {object} options
 * @param {Element} options.root          Container element; emptied and filled.
 * @param {() => object} options.provider Snapshot of the watched layers.
 * @param {(text: string) => void} [options.showToast]
 * @param {Document} [options.documentRef]
 * @param {Storage} [options.storage]
 * @param {() => number} [options.now]
 * @param {number} [options.intervalMs]
 * @param {number} [options.firstDelayMs]
 * @returns {{scanNow: () => Array<object>, render: () => void, destroy: () => void}}
 *   scanNow returns the incidents announced by that scan.
 */
export function mountAlertCenter({
  root,
  provider,
  showToast = () => {},
  documentRef = globalThis.document,
  storage = globalThis.localStorage,
  now = () => Date.now(),
  intervalMs = SCAN_INTERVAL_MS,
  firstDelayMs = FIRST_SCAN_DELAY_MS,
} = {}) {
  if (!root || !documentRef) {
    return { scanNow: () => [], render: () => {}, destroy: () => {} };
  }
  const doc = documentRef;
  const ids = { popup: 'alert-center-popup', heading: 'alert-center-heading' };
  const ui = buildMarkup(doc, ids);
  root.textContent = '';
  root.append(ui.wrap);

  const feed = new IncidentFeed({ now });
  feed.restoreDismissals(readDismissed(storage), now());

  let scanTimer = null;
  let firstTimer = null;
  let open = false;
  let baselined = false;

  const renderRow = (incident) => {
    const row = doc.createElement('li');
    row.className = 'alert-center-row';
    row.dataset.severity = incident.severity;
    row.dataset.kind = incident.kind;

    const dot = doc.createElement('span');
    dot.className = 'alert-center-severity';
    dot.setAttribute('aria-hidden', 'true');
    dot.title =
      incident.severity === INCIDENT_SEVERITY.critical
        ? t('Critical')
        : t('Warning');

    const body = doc.createElement('div');
    body.className = 'alert-center-body';
    const text = localizeIncident(incident);
    const title = doc.createElement('p');
    title.className = 'alert-center-title';
    title.textContent = text.title;
    body.append(title);
    if (text.detail) {
      const detail = doc.createElement('p');
      detail.className = 'alert-center-detail';
      detail.textContent = text.detail;
      body.append(detail);
    }
    const meta = doc.createElement('p');
    meta.className = 'alert-center-meta';
    const when = incidentTimeText(incident.atMs, now());
    const layer = layerNameForId(incident.layerId) || incident.layerId;
    meta.textContent = [when, layer].filter(Boolean).join(' · ');
    body.append(meta);

    const dismiss = doc.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'alert-center-dismiss';
    dismiss.setAttribute('aria-label', t('Dismiss alert'));
    dismiss.title = t('Dismiss alert');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => {
      feed.dismiss(incident.id, now());
      writeDismissed(storage, feed.dismissedEntries());
      render();
    });

    row.append(dot, body, dismiss);
    return row;
  };

  const render = () => {
    const items = feed.items();
    const count = items.length;
    ui.badge.hidden = count === 0;
    ui.badge.textContent = count > 99 ? '99+' : String(count);
    ui.button.setAttribute('aria-label', alertButtonLabel(count));
    ui.button.classList.toggle('has-alerts', count > 0);
    ui.button.classList.toggle(
      'has-critical',
      items.some((item) => item.severity === INCIDENT_SEVERITY.critical),
    );
    ui.purge.hidden = count === 0;
    if (!open) return;
    ui.list.textContent = '';
    for (const incident of items) ui.list.append(renderRow(incident));
    ui.empty.hidden = count > 0;
    ui.list.hidden = count === 0;
  };

  const setOpen = (next) => {
    open = next;
    ui.popup.hidden = !next;
    ui.button.setAttribute('aria-expanded', String(next));
    // The list drops DOWN over the rail chips, which sit in their own stacking
    // context above the action row; lift the row only while it is open. The
    // class goes on the row itself — the wrap sits in #alert-center, whose own
    // z-index cannot escape the row's stacking context.
    ui.wrap
      .closest?.('#top-center-actions')
      ?.classList?.toggle('alerts-open', next);
    if (next) render();
    else ui.button.focus?.({ preventScroll: true });
  };

  const onButtonClick = () => setOpen(!open);
  const onPurgeClick = () => {
    feed.dismissAll(now());
    writeDismissed(storage, feed.dismissedEntries());
    render();
  };
  const onDocumentPointer = (event) => {
    if (!open) return;
    if (ui.wrap.contains(event.target)) return;
    setOpen(false);
  };
  const onDocumentKey = (event) => {
    if (open && (event.key === 'Escape' || event.key === 'Esc')) {
      event.stopPropagation();
      setOpen(false);
    }
  };

  ui.button.addEventListener('click', onButtonClick);
  ui.purge.addEventListener('click', onPurgeClick);
  doc.addEventListener('pointerdown', onDocumentPointer, true);
  doc.addEventListener('keydown', onDocumentKey, true);

  /**
   * Read the watched layers once.
   * @returns {Array<object>} Incidents announced by this scan.
   */
  const scanNow = () => {
    let source = null;
    try {
      source = provider?.();
    } catch {
      return [];
    }
    if (!source) return [];
    const at = now();
    const incidents = scanIncidents(source, { now: at });
    const added = feed.update(incidents, at);
    render();
    if (!baselined) {
      // The first scan is the list's starting point, not news.
      baselined = true;
      return [];
    }
    const announced = added.filter(
      (incident) => !feed.isDismissed(incident.id),
    );
    const text = announceText(announced);
    if (text) showToast(`⚠ ${text}`);
    return announced;
  };

  const start = () => {
    firstTimer = globalThis.setTimeout?.(() => {
      firstTimer = null;
      scanNow();
      scanTimer = globalThis.setInterval?.(scanNow, intervalMs);
    }, firstDelayMs);
  };

  const destroy = () => {
    if (firstTimer) globalThis.clearTimeout?.(firstTimer);
    if (scanTimer) globalThis.clearInterval?.(scanTimer);
    firstTimer = scanTimer = null;
    ui.button.removeEventListener('click', onButtonClick);
    ui.purge.removeEventListener('click', onPurgeClick);
    doc.removeEventListener('pointerdown', onDocumentPointer, true);
    doc.removeEventListener('keydown', onDocumentKey, true);
    ui.wrap.closest?.('#top-center-actions')?.classList?.remove('alerts-open');
    ui.wrap.remove();
  };

  render();
  start();
  return { scanNow, render, destroy };
}
