import { formatDate, formatRelativeTime, t, tn } from '../i18n/index.js';
import { KEY_SETUP_OPEN_EVENT } from '../keySetupCore.mjs';
import { syncRowList } from './rowList.js';

/**
 * The conflict window: the deadliest ACLED events the layer currently holds.
 *
 * The Layers row card stops at five entries and keeps the severity legend; this
 * window is the longer list. It reads the layer's own `getRecentEvents()`
 * projection, so the window and the row card cannot disagree about a toll, an
 * event type, or a country.
 *
 * A source failure is stated in its own line, with the code the proxy returned
 * (`no_key`, `auth`, `unauthorized`, `upstream`, `unparseable`) plus a reason.
 * It shows even when the window still holds rows from an earlier read: a stale
 * list must not look like a working feed. The line is a button: clicking it
 * asks the layer for a fresh read, so fixing the credentials does not require
 * reloading the page.
 *
 * The freshness line states how long ago the proxy generated the displayed
 * snapshot. Its REFRESH button asks for a read that bypasses the proxy's
 * ten-minute cache, so a manual action reaches ACLED rather than the cache.
 */
export const CONFLICT_PANEL_ID = 'conflict-panel';
export const CONFLICT_LAYER_ID = 'conflict-events';
export const CONFLICT_PANEL_LIMIT = 50;
/**
 * The layer dispatches this when a dot is picked; this window opens and marks
 * the row. Kept as the same literal there (src/layers/conflict-events/index.js)
 * so the data layer never imports this UI module.
 */
const CONFLICT_EVENT_SELECTED_EVENT = 'gev:conflict-event-selected';

/** English reason for an error code; empty for a code we do not know. */
function errorReason(code) {
  switch (code) {
    case 'no_key':
      return t(
        'ACLED is not configured: add ACLED_EMAIL and ACLED_PASSWORD in POWER UP → Provider Settings',
      );
    case 'auth':
      return t('ACLED rejected the credentials');
    case 'unauthorized':
      return t('ACLED denied API access for this account');
    case 'upstream':
      return t('ACLED did not answer');
    case 'unparseable':
      return t('ACLED returned unreadable data');
    default:
      return '';
  }
}

/**
 * @param {object} input
 * @param {HTMLElement} input.container Panel body that hosts the error line and list.
 * @param {object} input.dataManager Data layer manager (`layers`, `subscribe`).
 * @param {number} [input.limit=50] Maximum events to list.
 * @param {Function|null} [input.reveal] Opens this panel in its chrome; called
 *   when a map pick selects an event.
 * @returns {{render: () => void, destroy: () => void}|null}
 */
export function createConflictPanel({
  container,
  dataManager,
  limit = CONFLICT_PANEL_LIMIT,
  reveal = null,
} = {}) {
  const document = container?.ownerDocument;
  if (
    !document?.createElement ||
    typeof dataManager?.subscribe !== 'function'
  ) {
    return null;
  }
  // A failure is worth acting on, so the line is a button rather than a notice.
  const errorLine = document.createElement('button');
  errorLine.type = 'button';
  errorLine.className = 'conflict-panel-error';
  errorLine.id = 'conflict-error';
  errorLine.hidden = true;
  errorLine.setAttribute('aria-live', 'polite');
  // A credential failure is one edit away: this button opens Provider Settings
  // at that exact row. An upstream failure keeps retry as its only action.
  const fix = document.createElement('button');
  fix.type = 'button';
  fix.className = 'conflict-panel-fix';
  fix.id = 'conflict-power-up';
  fix.textContent = t('POWER UP');
  fix.hidden = true;
  const freshness = document.createElement('div');
  freshness.className = 'conflict-panel-freshness';
  const freshnessText = document.createElement('span');
  freshnessText.className = 'conflict-panel-freshness-text';
  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'conflict-panel-refresh';
  refreshButton.textContent = t('REFRESH');
  refreshButton.disabled = true;
  freshness.append(freshnessText, refreshButton);
  const list = document.createElement('ol');
  list.className = 'data-row-list';
  list.id = 'conflict-events-list';
  list.hidden = true;
  const status = document.createElement('p');
  status.className = 'conflict-panel-status';
  status.id = 'conflict-status';
  const credit = document.createElement('p');
  credit.className = 'conflict-panel-credit';
  const creditLabel = document.createElement('span');
  creditLabel.textContent = t(
    'Data: ACLED (Armed Conflict Location & Event Data)',
  );
  const creditLink = document.createElement('a');
  creditLink.href = 'https://acleddata.com';
  creditLink.target = '_blank';
  creditLink.rel = 'noopener';
  creditLink.textContent = 'acleddata.com';
  const creditMeta = document.createElement('span');
  const creditSep = () => {
    const separator = document.createElement('span');
    separator.textContent = ' · ';
    return separator;
  };
  credit.append(creditLabel, creditSep(), creditLink, creditSep(), creditMeta);
  container.append(errorLine, fix, freshness, status, credit, list);
  const badge = container
    .closest?.('[data-panel-id]')
    ?.querySelector?.('#conflict-count');

  let destroyed = false;
  let retrying = false;
  let selectedId = null;
  let lastScrolledId = null;
  const layerFor = () =>
    dataManager.layers?.get?.(CONFLICT_LAYER_ID)?.module ?? null;

  /** The layer's error code, read defensively: panels never throw. */
  const errorFor = (layer) => {
    try {
      return layer?.getLastError?.() ?? layer?.getStats?.()?.error ?? null;
    } catch {
      return null;
    }
  };

  /** "2 minutes ago" from the proxy's read stamp; the unit grows with age. */
  const ageLabel = (generatedAt) => {
    const seconds = Math.max(0, (Date.now() - generatedAt) / 1000);
    if (seconds < 45) return t('just now');
    if (seconds < 3600)
      return formatRelativeTime(
        -Math.max(1, Math.floor(seconds / 60)),
        'minute',
      );
    if (seconds < 86_400)
      return formatRelativeTime(
        -Math.max(1, Math.floor(seconds / 3600)),
        'hour',
      );
    return formatRelativeTime(
      -Math.max(1, Math.floor(seconds / 86_400)),
      'day',
    );
  };

  const renderCredit = (layer = layerFor()) => {
    if (destroyed) return;
    let generatedAt = null;
    try {
      generatedAt = layer?.getStats?.()?.generatedAt ?? null;
    } catch {
      generatedAt = null;
    }
    const accessed = Number.isFinite(generatedAt)
      ? t('accessed {date}', {
          date: formatDate(generatedAt, { dateStyle: 'medium' }),
        })
      : '';
    const meta = [t('Last 7 days'), accessed].filter(Boolean).join(' · ');
    if (creditMeta.textContent !== meta) creditMeta.textContent = meta;
  };

  const renderFreshness = (layer = layerFor()) => {
    if (destroyed) return;
    let generatedAt = null;
    try {
      generatedAt = layer?.getStats?.()?.generatedAt ?? null;
    } catch {
      generatedAt = null;
    }
    const known = Number.isFinite(generatedAt);
    const text = known
      ? t('Feed updated {age}', { age: ageLabel(generatedAt) })
      : t('No snapshot yet');
    if (freshnessText.textContent !== text) freshnessText.textContent = text;
    const title = known
      ? formatDate(generatedAt, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : '';
    if (freshness.title !== title) freshness.title = title;
    const canRefresh = typeof layer?.refresh === 'function';
    refreshButton.hidden = !canRefresh;
    refreshButton.disabled = !canRefresh || retrying;
  };

  const render = () => {
    // While a retry is in flight the line states that, not the old failure.
    if (destroyed || retrying) return;
    const layer = layerFor();
    renderFreshness(layer);
    renderCredit(layer);
    let items =
      typeof layer?.getRecentEvents === 'function'
        ? layer.getRecentEvents(limit, selectedId)
        : [];
    // A selected event that a later snapshot no longer holds is not a ghost
    // row: drop the selection rather than claiming it is still on the globe.
    if (selectedId && !items.some((item) => item.id === selectedId))
      selectedId = null;
    if (selectedId)
      items = items.map((item) =>
        item.id === selectedId ? { ...item, active: true } : item,
      );
    syncRowList(list, {
      ariaLabel: t('Deadliest conflict events'),
      items,
    });
    list.hidden = items.length === 0;
    if (selectedId && selectedId !== lastScrolledId) {
      lastScrolledId = selectedId;
      const showSelected = () => {
        const selected = [
          ...(list.querySelectorAll?.('.data-row-list-item') || []),
        ].find((node) => node.dataset?.listItemId === selectedId);
        selected?.scrollIntoView?.({ block: 'nearest' });
      };
      // The panel may have just been revealed; one frame lets its chrome lay
      // the scroller out before the row asks to be brought into view.
      if (typeof globalThis.requestAnimationFrame === 'function')
        globalThis.requestAnimationFrame(showSelected);
      else showSelected();
    } else if (!selectedId) {
      lastScrolledId = null;
    }
    if (badge) {
      const label = tn(items.length, '{count} event', '{count} events');
      if (badge.textContent !== label) badge.textContent = label;
    }

    const error = errorFor(layer);
    if (error) {
      // The code stays a literal token: it is what the proxy logged.
      const reason = errorReason(String(error));
      const text = reason
        ? `${t('Source error')} · ${error} · ${reason}`
        : `${t('Source error')} · ${error}`;
      if (errorLine.textContent !== text) errorLine.textContent = text;
      errorLine.setAttribute('data-code', String(error));
      errorLine.title = t('Retry the read');
      errorLine.setAttribute('aria-label', `${text}. ${t('Retry the read')}`);
      errorLine.hidden = false;
      // Every credential failure has an action in Provider Settings: add a
      // missing pair, replace rejected credentials, or follow the account's
      // own access link. An upstream failure does not.
      const credentialFailure = ['no_key', 'auth', 'unauthorized'].includes(
        String(error),
      );
      fix.hidden = !credentialFailure;
      if (credentialFailure && reason) {
        if (fix.getAttribute('aria-label') !== reason)
          fix.setAttribute('aria-label', reason);
        fix.title = reason;
      }
      // The info line repeats the same code; the error line owns it now.
      status.hidden = true;
      return;
    }
    errorLine.hidden = true;
    errorLine.removeAttribute('data-code');
    fix.hidden = true;
    // The layer's own info line is already translated and already says why the
    // list is empty (no credentials, an upstream error, or no event yet).
    const info = layer?.getRowControls?.()?.info ?? t('ACLED');
    status.hidden = items.length > 0;
    if (status.textContent !== info) status.textContent = info;
  };

  async function readNow() {
    if (retrying || destroyed) return;
    const layer = layerFor();
    const run = typeof layer?.refresh === 'function' ? layer.refresh : null;
    if (!run) return;
    retrying = true;
    errorLine.disabled = true;
    errorLine.setAttribute('aria-busy', 'true');
    errorLine.textContent = t('Retrying…');
    refreshButton.disabled = true;
    refreshButton.setAttribute('aria-busy', 'true');
    try {
      await run.call(layer);
    } catch {
      // The layer records its own failure; render() states it below.
    } finally {
      retrying = false;
      if (!destroyed) {
        errorLine.disabled = false;
        errorLine.removeAttribute('aria-busy');
        refreshButton.disabled = false;
        refreshButton.removeAttribute('aria-busy');
        render();
        renderFreshness(layer);
      }
    }
  }

  errorLine.onclick = () => {
    void readNow();
  };
  refreshButton.onclick = () => {
    void readNow();
  };

  const onEventSelected = (event) => {
    const eventId = String(event?.detail?.eventId ?? '');
    if (!eventId) return;
    selectedId = eventId;
    lastScrolledId = null;
    try {
      if (typeof reveal === 'function') reveal();
    } catch {
      // The selected row still renders even if its chrome cannot open.
    }
    render();
  };
  document.addEventListener?.(CONFLICT_EVENT_SELECTED_EVENT, onEventSelected);

  fix.onclick = () => {
    const EventCtor =
      document.defaultView?.CustomEvent ?? globalThis.CustomEvent;
    if (
      typeof EventCtor !== 'function' ||
      typeof document.dispatchEvent !== 'function'
    )
      return;
    document.dispatchEvent(
      new EventCtor(KEY_SETUP_OPEN_EVENT, { detail: { keyId: 'acled' } }),
    );
  };

  const unsubscribe = dataManager.subscribe(render);
  render();
  // Keep "how old" honest while the window is open. The list itself only
  // re-renders on a data change; the age would otherwise freeze at mount.
  const freshnessTimer = globalThis.setInterval?.(
    () => renderFreshness(),
    30_000,
  );
  freshnessTimer?.unref?.();

  return {
    render,
    destroy() {
      destroyed = true;
      if (typeof unsubscribe === 'function') unsubscribe();
      document.removeEventListener?.(
        CONFLICT_EVENT_SELECTED_EVENT,
        onEventSelected,
      );
      globalThis.clearInterval?.(freshnessTimer);
      errorLine.remove();
      fix.remove();
      freshness.remove();
      credit.remove();
      list.remove();
      status.remove();
    },
  };
}
