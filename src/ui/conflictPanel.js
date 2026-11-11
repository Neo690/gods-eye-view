import { t, tn } from '../i18n/index.js';
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
 */
export const CONFLICT_PANEL_ID = 'conflict-panel';
export const CONFLICT_LAYER_ID = 'conflict-events';
export const CONFLICT_PANEL_LIMIT = 50;

/** English reason for an error code; empty for a code we do not know. */
function errorReason(code) {
  switch (code) {
    case 'no_key':
      return t(
        'ACLED is not configured: set ACLED_EMAIL and ACLED_PASSWORD in .env',
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
 * @returns {{render: () => void, destroy: () => void}|null}
 */
export function createConflictPanel({
  container,
  dataManager,
  limit = CONFLICT_PANEL_LIMIT,
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
  const list = document.createElement('ol');
  list.className = 'data-row-list';
  list.id = 'conflict-events-list';
  list.hidden = true;
  const status = document.createElement('p');
  status.className = 'conflict-panel-status';
  status.id = 'conflict-status';
  container.append(errorLine, status, list);
  const badge = container
    .closest?.('[data-panel-id]')
    ?.querySelector?.('#conflict-count');

  let destroyed = false;
  let retrying = false;
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

  const render = () => {
    // While a retry is in flight the line states that, not the old failure.
    if (destroyed || retrying) return;
    const layer = layerFor();
    const items =
      typeof layer?.getRecentEvents === 'function'
        ? layer.getRecentEvents(limit)
        : [];
    syncRowList(list, {
      ariaLabel: t('Deadliest conflict events'),
      items,
    });
    list.hidden = items.length === 0;
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
      // The info line repeats the same code; the error line owns it now.
      status.hidden = true;
      return;
    }
    errorLine.hidden = true;
    errorLine.removeAttribute('data-code');
    // The layer's own info line is already translated and already says why the
    // list is empty (no credentials, an upstream error, or no event yet).
    const info = layer?.getRowControls?.()?.info ?? t('ACLED');
    status.hidden = items.length > 0;
    if (status.textContent !== info) status.textContent = info;
  };

  async function retry() {
    if (retrying || destroyed) return;
    const layer = layerFor();
    const run = typeof layer?.refresh === 'function' ? layer.refresh : null;
    if (!run) return;
    retrying = true;
    errorLine.disabled = true;
    errorLine.setAttribute('aria-busy', 'true');
    errorLine.textContent = t('Retrying…');
    try {
      await run.call(layer);
    } catch {
      // The layer records its own failure; render() states it below.
    } finally {
      retrying = false;
      if (!destroyed) {
        errorLine.disabled = false;
        errorLine.removeAttribute('aria-busy');
        render();
      }
    }
  }

  errorLine.onclick = () => {
    void retry();
  };

  const unsubscribe = dataManager.subscribe(render);
  render();

  return {
    render,
    destroy() {
      destroyed = true;
      if (typeof unsubscribe === 'function') unsubscribe();
      errorLine.remove();
      list.remove();
      status.remove();
    },
  };
}
