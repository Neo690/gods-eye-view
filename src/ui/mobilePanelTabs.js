import { t } from '../i18n/index.js';
import {
  PANEL_WINDOW_NARROW_MEDIA,
  PANEL_WINDOW_SPECS,
} from './panelWindows.js';

/**
 * The rail windows a phone reaches through one disclosure, in reading order.
 *
 * On a phone the rails collapse to two wrapped rows of chips — one owned by
 * `#left-panel-stack` (Data, Scenes) and one by `#right-context-rail` (Display,
 * CCTV, Street Level, Context). Two rows of identical chips read as one broken
 * row, and Context, last in a wrap, is stranded far below its siblings. A first
 * attempt drew all six as a fixed 3×2 grid; that moved the clutter onto the map
 * instead of out of it. One closed button owns them now: the globe keeps the
 * top of the screen, and the list only appears when it is asked for.
 *
 * The list itself is shared with the desktop drawer (`panelWindows.js`), so a
 * renamed window cannot be offered on one screen and missing from the other.
 */
export const MOBILE_PANEL_TAB_SPECS = PANEL_WINDOW_SPECS;

/** The one breakpoint the disclosure exists at; above it the rails keep their chips. */
export const MOBILE_PANEL_TAB_MEDIA = PANEL_WINDOW_NARROW_MEDIA;

/**
 * Build the panel disclosure above the map, or return null when the document
 * has none of its panels.
 *
 * Behaviour belongs to the caller through `setPanelCollapsed`, so persistence,
 * share state and the Cockpit rail stay in step with a menu press. One panel is
 * open at a time on a phone; opening one collapses the others, and choosing an
 * open window closes it.
 *
 * @param {object} input
 * @param {Document} [input.document]
 * @param {(panelId: string, collapsed: boolean, options?: object) => void} input.setPanelCollapsed
 * @param {() => boolean} [input.isMobile] Whether the one-open-at-a-time rule applies.
 * @returns {{element: HTMLElement, sync: () => void, destroy: () => void}|null}
 */
export function createMobilePanelTabs({
  document: doc = globalThis.document,
  setPanelCollapsed,
  isMobile = () =>
    !!doc?.defaultView?.matchMedia?.(MOBILE_PANEL_TAB_MEDIA)?.matches,
} = {}) {
  if (!doc?.body || typeof setPanelCollapsed !== 'function') return null;
  const createElement = (tag) => doc.createElement(tag);

  const nav = createElement('nav');
  nav.id = 'gev-panel-tabs';
  nav.className = 'gev-panel-tabs';

  const toggle = createElement('button');
  toggle.type = 'button';
  toggle.className = 'gev-panel-tabs-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'gev-panel-tabs-menu');
  toggle.setAttribute('aria-label', t('Map windows'));
  toggle.title = t('Map windows');
  // Drawn with CSS, not the Material Symbols ligature: the app loads that font
  // over the network, and an icon-only button whose font failed would render
  // the literal word "tune" across the map.
  const toggleIcon = createElement('span');
  toggleIcon.className = 'gev-panel-tabs-glyph';
  toggleIcon.setAttribute('aria-hidden', 'true');
  // Says "a window is open" without taking a second row of chips to say it.
  const openDot = createElement('span');
  openDot.className = 'gev-panel-tabs-dot';
  openDot.setAttribute('aria-hidden', 'true');
  toggle.append(toggleIcon, openDot);

  const menu = createElement('div');
  menu.id = 'gev-panel-tabs-menu';
  menu.className = 'gev-panel-tabs-menu';
  menu.hidden = true;

  const items = new Map();
  for (const spec of MOBILE_PANEL_TAB_SPECS) {
    if (!doc.getElementById(spec.id)) continue;
    const item = createElement('button');
    item.type = 'button';
    item.className = 'gev-panel-tabs-item';
    item.dataset.panelTab = spec.id;
    item.setAttribute('aria-pressed', 'false');
    item.textContent = t(spec.label);
    menu.append(item);
    items.set(spec.id, item);
  }
  if (!items.size) return null;

  nav.append(toggle, menu);
  // Rides the globe action row, immediately left of the flag: that row already
  // owns 34px glass buttons at the top of the map, and a second floating
  // control under it was one more thing between the globe and the map. The
  // strip stays hidden above the breakpoint (mobile-compact.css), so the row
  // is untouched on a desktop.
  const actionRow = doc.getElementById('top-center-actions');
  const host = actionRow || doc.body;
  if (actionRow) actionRow.prepend(nav);
  else doc.body.append(nav);

  const openPanels = () => {
    const open = new Set();
    for (const id of items.keys()) {
      const panel = doc.getElementById(id);
      if (panel && !panel.classList.contains('collapsed')) open.add(id);
    }
    return open;
  };

  let expanded = false;
  const setExpanded = (next, { focusToggle = false } = {}) => {
    expanded = next;
    menu.hidden = !next;
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    // The row is a stacking context of its own, so the list cannot outrank an
    // open window's sheet from inside it: the row itself steps forward while
    // the list is showing, and back again when it closes.
    host.classList?.toggle?.('panel-tabs-open', next);
    if (focusToggle) toggle.focus?.();
  };

  const sync = () => {
    const open = openPanels();
    for (const [id, item] of items) {
      const selected = open.has(id);
      item.setAttribute('aria-pressed', selected ? 'true' : 'false');
      item.dataset.open = selected ? 'true' : 'false';
    }
    nav.dataset.open = open.size ? 'true' : 'false';
  };

  /** Choosing a window: toggle it like its chip did, then put the list away. */
  const choose = (id) => {
    const panel = doc.getElementById(id);
    if (!panel) return;
    if (!panel.classList.contains('collapsed')) {
      setPanelCollapsed(id, true, { explicit: true });
    } else {
      if (isMobile())
        for (const other of items.keys()) {
          if (other === id) continue;
          const sibling = doc.getElementById(other);
          if (sibling && !sibling.classList.contains('collapsed'))
            setPanelCollapsed(other, true, { explicit: false });
        }
      setPanelCollapsed(id, false, { explicit: true });
    }
    sync();
    setExpanded(false);
  };

  const onClick = (event) => {
    if (event.target?.closest?.('.gev-panel-tabs-toggle')) {
      setExpanded(!expanded);
      return;
    }
    const id = event.target?.closest?.('[data-panel-tab]')?.dataset?.panelTab;
    if (id) choose(id);
  };

  // A menu that stays open behind a tap on the map is a trap: close it on the
  // first press elsewhere, without swallowing that press.
  const onPointerDown = (event) => {
    if (!expanded) return;
    if (nav.contains?.(event.target)) return;
    setExpanded(false);
  };

  const onKeyDown = (event) => {
    if (!expanded) return;
    if (event.key !== 'Escape' && event.key !== 'Esc') return;
    setExpanded(false, { focusToggle: true });
  };

  nav.addEventListener('click', onClick);
  doc.addEventListener?.('pointerdown', onPointerDown);
  doc.addEventListener?.('keydown', onKeyDown);

  const observers = [];
  const MutationObserver = doc.defaultView?.MutationObserver;
  if (MutationObserver)
    for (const id of items.keys()) {
      const panel = doc.getElementById(id);
      if (!panel) continue;
      const observer = new MutationObserver(sync);
      observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
      observers.push(observer);
    }

  sync();
  return {
    element: nav,
    sync,
    destroy() {
      nav.removeEventListener('click', onClick);
      doc.removeEventListener?.('pointerdown', onPointerDown);
      doc.removeEventListener?.('keydown', onKeyDown);
      for (const observer of observers) observer.disconnect();
      observers.length = 0;
      nav.remove();
    },
  };
}
