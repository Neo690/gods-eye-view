import { PANEL_WINDOW_IDS } from './panelWindows.js';

/**
 * One rail window open at a time on a desktop.
 *
 * The rails are vertical accords: Data layers, Scenes, Display, CCTV, Street
 * Level and Context are all one click apart, and on a wide screen the operator
 * can currently end up with four of them open — four columns of chrome over the
 * globe. The phone already refuses that (mobilePanelTabs.js closes the siblings
 * before it opens a window); this is the same rule for the desktop, expressed
 * as data so it can be tested without a browser.
 *
 * A window closed by this rule is marked `rail-accordion-collapsed`, which is
 * what makes the rule reversible: the marker says "the accordion put this
 * away", so releasing the rule (a phone layout, Cockpit, an embed) reopens
 * exactly those windows and leaves every window the operator closed by hand
 * closed. A marked window is never persisted, because it was closed by another
 * window opening, not by the operator.
 */

/** Window closed by the accordion rather than by the operator. */
export const RAIL_ACCORDION_CLASS = 'rail-accordion-collapsed';

/**
 * Decide one accordion pass.
 *
 * Pure: it reads a description of the rail windows and reports what to change.
 * `ownerId` is the window the operator just opened, and it must be a rail
 * window — anything else (a phone, a Cockpit rail, a typo) plans nothing at
 * all rather than guessing at an owner.
 *
 * @param {Array<{id: string, collapsed: boolean, accordionCollapsed?: boolean}>} panels
 * @param {string|null} ownerId
 * @returns {{collapse: string[], unmark: string[], release: string[]}}
 *   `collapse`: close and mark. `unmark`: open already — only the marker goes.
 *   `release`: reopen and unmark (the rule no longer applies).
 */
export function railAccordionPlan(panels, ownerId) {
  const list = Array.isArray(panels) ? panels : [];
  if (!PANEL_WINDOW_IDS.includes(ownerId)) {
    return { collapse: [], unmark: [], release: [] };
  }
  const collapse = [];
  const unmark = [];
  for (const panel of list) {
    if (!PANEL_WINDOW_IDS.includes(panel?.id)) continue;
    if (panel.id === ownerId) {
      // The operator's own window stays open, and stops counting as ours.
      if (panel.accordionCollapsed) unmark.push(panel.id);
      continue;
    }
    // A window the operator closed by hand is none of the accordion's
    // business: marking it would reopen it later behind their back.
    if (panel.collapsed) continue;
    collapse.push(panel.id);
  }
  return { collapse, unmark, release: [] };
}

/**
 * Every window the accordion put away, back to the operator's own state.
 * @param {Array<{id: string, accordionCollapsed?: boolean}>} panels
 * @returns {{collapse: string[], unmark: string[], release: string[]}}
 */
export function railAccordionReleasePlan(panels) {
  return {
    collapse: [],
    unmark: [],
    release: (Array.isArray(panels) ? panels : [])
      .filter((panel) => panel?.accordionCollapsed)
      .map((panel) => panel.id),
  };
}

/**
 * Read the rail windows out of a document.
 * @param {Document} documentRef
 * @returns {Array<{id: string, element: HTMLElement, collapsed: boolean, accordionCollapsed: boolean}>}
 */
export function readRailPanels(documentRef = globalThis.document) {
  const panels = [];
  if (!documentRef?.getElementById) return panels;
  for (const id of PANEL_WINDOW_IDS) {
    const element = documentRef.getElementById(id);
    if (!element?.classList) continue;
    panels.push({
      id,
      element,
      collapsed: element.classList.contains('collapsed'),
      accordionCollapsed: element.classList.contains(RAIL_ACCORDION_CLASS),
    });
  }
  return panels;
}

/**
 * Apply one accordion pass to the document.
 *
 * Callers own scheduling and know whether the rule applies at all: pass
 * `enabled: false` for a phone layout, a Cockpit rail or an embed, and every
 * window the accordion had put away is released.
 *
 * @param {object} options
 * @param {string|null} [options.ownerId] Window to leave open.
 * @param {boolean} [options.enabled]
 * @param {Document} [options.documentRef]
 * @returns {{collapse: string[], unmark: string[], release: string[]}} What changed.
 */
export function applyRailAccordion({
  ownerId = null,
  enabled = true,
  documentRef = globalThis.document,
} = {}) {
  const panels = readRailPanels(documentRef);
  if (!panels.length) return { collapse: [], unmark: [], release: [] };
  const plan = enabled
    ? railAccordionPlan(panels, ownerId)
    : railAccordionReleasePlan(panels);
  const elements = new Map(panels.map((panel) => [panel.id, panel.element]));
  for (const id of plan.unmark) {
    elements.get(id).classList.remove(RAIL_ACCORDION_CLASS);
  }
  for (const id of plan.release) {
    elements.get(id).classList.remove('collapsed', RAIL_ACCORDION_CLASS);
  }
  for (const id of plan.collapse) {
    elements.get(id).classList.add('collapsed', RAIL_ACCORDION_CLASS);
  }
  return plan;
}
