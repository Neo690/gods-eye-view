import { msg } from '../i18n/index.js';

/**
 * The rail windows, in reading order — one list for both ways in.
 *
 * A phone reaches them through one disclosure (#gev-panel-tabs), a desktop
 * through one tabbed drawer docked to the left edge (#gev-panel-drawer).
 * The two share this list so a renamed panel cannot end up offered on one
 * screen and missing from the other, and so the labels stay the panels' own
 * English source strings, which `t()` already resolves everywhere else.
 *
 * Each label is wrapped in `msg()` because the literal ships as a key rather
 * than as page text: it is translated at `t(spec.label)` by the caller, and the
 * wrapper is what tells `npm run i18n` so.
 */
export const PANEL_WINDOW_SPECS = Object.freeze([
  Object.freeze({ id: 'data-panel', label: msg('DATA LAYERS') }),
  Object.freeze({ id: 'scene-panel', label: msg('SCENES') }),
  Object.freeze({ id: 'pp-toggles', label: msg('DISPLAY') }),
  Object.freeze({ id: 'cctv-panel', label: msg('CCTV') }),
  Object.freeze({ id: 'street-level-panel', label: msg('STREET LEVEL') }),
  Object.freeze({ id: 'global-context-panel', label: msg('CONTEXT') }),
]);

/** Phones keep the disclosure; above this the tabbed drawer takes over. */
export const PANEL_WINDOW_NARROW_MEDIA = '(max-width: 720px)';

/** Every id in this list, for tests and callers that only need the keys. */
export const PANEL_WINDOW_IDS = Object.freeze(
  PANEL_WINDOW_SPECS.map((spec) => spec.id),
);
