import { msg, t } from '../i18n/index.js';
import { PANEL_WINDOW_SPECS } from './panelWindows.js';

/**
 * The desktop drawer: the six rail windows as tabs, on one edge.
 *
 * Two rails of chips — Data layers and Scenes on the left, Display, CCTV,
 * Street Level and Context on the right — ask the operator to look in two
 * places for one thing: the panel they want. The drawer puts every window in a
 * single vertical list docked to the left edge, so there is one place to look
 * and one gesture to learn. The window itself still opens where it always did
 * (its rail, its sheet, its saved size); the drawer is only the way in.
 *
 * A tab press goes through the caller's `setPanelCollapsed`, the same call a
 * chip press makes, so persistence, share links, the Cockpit rail and the new
 * desktop accordion all stay in step. The drawer never decides that a window
 * should close: the accordion does, in one place.
 *
 * Phones keep the disclosure they already have (#gev-panel-tabs); this drawer
 * is hidden there by CSS, and in Cockpit and embed views where the rails have
 * their own layouts.
 */

/** The one breakpoint that decides which way in a viewport gets. */
export const PANEL_DRAWER_MEDIA = '(min-width: 721px)';

/**
 * Build the drawer, or return null when the document has none of its windows.
 *
 * @param {object} input
 * @param {Document} [input.document]
 * @param {(panelId: string, collapsed: boolean, options?: object) => void} input.setPanelCollapsed
 * @param {() => boolean} [input.isWide] Whether the drawer's layout applies.
 * @returns {{element: HTMLElement, sync: () => void, destroy: () => void}|null}
 */
export function createPanelDrawer({
  document: doc = globalThis.document,
  setPanelCollapsed,
  isWide = () => !!doc?.defaultView?.matchMedia?.(PANEL_DRAWER_MEDIA)?.matches,
} = {}) {
  if (!doc?.body || typeof setPanelCollapsed !== 'function') return null;
  const createElement = (tag) => doc.createElement(tag);

  const nav = createElement('nav');
  nav.id = 'gev-panel-drawer';
  nav.className = 'gev-panel-drawer';

  const toggle = createElement('button');
  toggle.type = 'button';
  toggle.className = 'gev-panel-drawer-toggle';
  toggle.setAttribute('aria-controls', 'gev-panel-drawer-list');
  // A drawn glyph, not a Material Symbols ligature: the app loads that font
  // over the network, and an icon-only button whose font failed would render
  // the literal word across the map (see mobilePanelTabs.js).
  const glyph = createElement('span');
  glyph.className = 'gev-panel-drawer-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  toggle.append(glyph);

  const list = createElement('div');
  list.id = 'gev-panel-drawer-list';
  list.className = 'gev-panel-drawer-list';

  const items = new Map();
  for (const spec of PANEL_WINDOW_SPECS) {
    if (!doc.getElementById(spec.id)) continue;
    const tab = createElement('button');
    tab.type = 'button';
    tab.className = 'gev-panel-drawer-tab';
    tab.dataset.panelDrawerTab = spec.id;
    tab.setAttribute('aria-pressed', 'false');
    const label = createElement('span');
    label.className = 'gev-panel-drawer-label';
    label.textContent = t(spec.label);
    tab.append(label);
    list.append(tab);
    items.set(spec.id, tab);
  }
  if (!items.size) return null;

  nav.append(toggle, list);
  doc.body.append(nav);
  // The stylesheet keys off this: the drawer replaces the rails' collapsed
  // chips, so a page that failed to build the drawer must keep them.
  doc.body.classList?.add('panel-drawer');

  const openPanels = () => {
    const open = new Set();
    for (const id of items.keys()) {
      const panel = doc.getElementById(id);
      if (panel && !panel.classList.contains('collapsed')) open.add(id);
    }
    return open;
  };

  // The list starts open: a way in nobody can see is not a way in. The toggle
  // tucks the whole drawer away for an operator who wants the edge back.
  let expanded = true;
  const setExpanded = (next, { focusToggle = false } = {}) => {
    expanded = next;
    list.hidden = !next;
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    nav.dataset.expanded = next ? 'true' : 'false';
    // Literals wrapped in msg(): the key ships as a key, and `npm run i18n`
    // cannot see a string that only ever exists inside a variable.
    const labelKey = next
      ? msg('Hide the window list')
      : msg('Show the window list');
    toggle.title = t(labelKey);
    toggle.setAttribute('aria-label', t(labelKey));
    if (focusToggle) toggle.focus?.();
  };

  const sync = () => {
    const open = openPanels();
    for (const [id, tab] of items) {
      const selected = open.has(id);
      tab.setAttribute('aria-pressed', selected ? 'true' : 'false');
      tab.dataset.open = selected ? 'true' : 'false';
      const spec = PANEL_WINDOW_SPECS.find((entry) => entry.id === id);
      const label = spec ? t(spec.label) : id;
      tab.title = label;
    }
    nav.dataset.open = open.size ? 'true' : 'false';
  };

  /** Choosing a window toggles it, exactly like pressing its old chip did. */
  const choose = (id) => {
    const panel = doc.getElementById(id);
    if (!panel) return;
    const isOpen = !panel.classList.contains('collapsed');
    setPanelCollapsed(id, isOpen, { explicit: true });
    sync();
  };

  const onClick = (event) => {
    if (event.target?.closest?.('.gev-panel-drawer-toggle')) {
      setExpanded(!expanded);
      return;
    }
    const id = event.target?.closest?.('[data-panel-drawer-tab]')?.dataset
      ?.panelDrawerTab;
    if (id) choose(id);
  };

  const onKeyDown = (event) => {
    if (!expanded) return;
    if (event.key !== 'Escape' && event.key !== 'Esc') return;
    setExpanded(false, { focusToggle: true });
  };

  nav.addEventListener('click', onClick);
  doc.addEventListener?.('keydown', onKeyDown);

  const observers = [];
  const MutationObserver = doc.defaultView?.MutationObserver;
  if (MutationObserver) {
    for (const id of items.keys()) {
      const panel = doc.getElementById(id);
      if (!panel) continue;
      const observer = new MutationObserver(sync);
      observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
      observers.push(observer);
    }
  }

  setExpanded(true);
  sync();
  return {
    element: nav,
    sync,
    isWide,
    destroy() {
      nav.removeEventListener('click', onClick);
      doc.removeEventListener?.('keydown', onKeyDown);
      for (const observer of observers) observer.disconnect();
      observers.length = 0;
      nav.remove();
      doc.body.classList?.remove('panel-drawer');
    },
  };
}
