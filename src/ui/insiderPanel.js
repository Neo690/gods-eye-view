import { t, tn } from '../i18n/index.js';
import { syncRowList } from './rowList.js';

/**
 * The insider window: every Form 4 the layer currently holds, newest first.
 *
 * The Layers row card stops at five entries — the right size for a row inside
 * another panel. This window is the full list. It reads the layer's own
 * `getRecentFilings()` projection, so the window and the row card can never
 * disagree about an issuer, an owner, or a form type.
 *
 * The window renders even while the layer is off: it then states the layer's
 * own info line ("SEC EDGAR · 0 filings") instead of showing an empty box.
 */
export const INSIDER_PANEL_ID = 'insider-panel';
export const INSIDER_LAYER_ID = 'insider';
export const INSIDER_PANEL_LIMIT = 50;

/**
 * @param {object} input
 * @param {HTMLElement} input.container Panel body that hosts the list.
 * @param {object} input.dataManager Data layer manager (`layers`, `subscribe`).
 * @param {number} [input.limit=50] Maximum filings to list.
 * @returns {{render: () => void, destroy: () => void}|null}
 */
export function createInsiderPanel({
  container,
  dataManager,
  limit = INSIDER_PANEL_LIMIT,
} = {}) {
  const document = container?.ownerDocument;
  if (
    !document?.createElement ||
    typeof dataManager?.subscribe !== 'function'
  ) {
    return null;
  }
  const list = document.createElement('ol');
  list.className = 'data-row-list';
  list.id = 'insider-filings';
  list.hidden = true;
  const status = document.createElement('p');
  status.className = 'insider-panel-status';
  status.id = 'insider-status';
  container.append(status, list);
  const badge = container
    .closest?.('[data-panel-id]')
    ?.querySelector?.('#insider-count');

  let destroyed = false;
  const layerFor = () =>
    dataManager.layers?.get?.(INSIDER_LAYER_ID)?.module ?? null;

  const render = () => {
    if (destroyed) return;
    const layer = layerFor();
    const items =
      typeof layer?.getRecentFilings === 'function'
        ? layer.getRecentFilings(limit)
        : [];
    syncRowList(list, {
      ariaLabel: t('Latest insider filings'),
      items,
    });
    list.hidden = items.length === 0;
    if (badge) {
      const label = tn(items.length, '{count} filing', '{count} filings');
      if (badge.textContent !== label) badge.textContent = label;
    }
    // The layer's own info line is already translated and already says why the
    // list is empty (no credentials, an upstream error, or simply nothing yet).
    const info = layer?.getRowControls?.()?.info ?? t('SEC EDGAR');
    status.hidden = items.length > 0;
    if (status.textContent !== info) status.textContent = info;
  };

  const unsubscribe = dataManager.subscribe(render);
  render();

  return {
    render,
    destroy() {
      destroyed = true;
      if (typeof unsubscribe === 'function') unsubscribe();
      list.remove();
      status.remove();
    },
  };
}
