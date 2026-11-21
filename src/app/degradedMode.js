import { t } from '../i18n/index.js';

/**
 * What a startup that stalled part-way can still do.
 *
 * A phase that never settled leaves every later phase unbuilt, but the markup
 * for their controls is in the page from the first paint. A scene panel whose
 * director was never constructed looks enabled and answers nothing, which is
 * worse than an absent feature: the operator presses it and reads the silence
 * as a broken app. This module turns those controls off and says what is
 * missing, and the startup guard's notice carries the same list as words.
 */

/** The feature a missing phase takes with it, in the reader's language. */
const FEATURE_LABELS = Object.freeze({
  scene: () => t('the globe'),
  controls: () => t('the console'),
  data: () => t('live data'),
  tools: () => t('scenes, drawing and voice'),
});

export const DEGRADED_PHASES = Object.freeze(Object.keys(FEATURE_LABELS));

/**
 * The features a degraded boot cannot offer, as one readable list.
 *
 * @param {string[]} [missing] phases that never settled
 * @returns {string} '' when nothing is missing
 */
export function unavailableFeatures(missing = []) {
  return (Array.isArray(missing) ? missing : [])
    .map((phase) => FEATURE_LABELS[phase]?.() ?? '')
    .filter(Boolean)
    .join(', ');
}

/** One control a degraded boot must not leave pressable. */
function disableControl(control) {
  if (!control) return 0;
  // A control the app had already disabled stays as it was, title included.
  if (control.disabled === true) return 0;
  control.disabled = true;
  control.setAttribute?.('aria-disabled', 'true');
  control.title = t('Unavailable until you reload');
  control.dataset && (control.dataset.degraded = 'true');
  return 1;
}

/**
 * Turn off the controls whose owning phase never arrived.
 *
 * A host declares the phase it needs with `data-requires="tools"`; everything
 * focusable inside it is disabled, and a host that is itself a control is
 * disabled too. Nothing is removed: the layout stays where the operator knows
 * it, and each control explains itself on hover.
 *
 * @param {object} [options]
 * @param {string[]} [options.missing] phases that never settled
 * @param {Document} [options.root] Test seam.
 * @returns {number} how many controls were turned off
 */
export function applyDegradedControls({
  missing = [],
  root = globalThis.document,
} = {}) {
  const phases = new Set(Array.isArray(missing) ? missing : []);
  if (!phases.size || typeof root?.querySelectorAll !== 'function') return 0;
  let count = 0;
  for (const host of root.querySelectorAll('[data-requires]')) {
    if (
      !phases.has(
        host.dataset?.requires ?? host.getAttribute?.('data-requires'),
      )
    )
      continue;
    host.dataset && (host.dataset.degraded = 'true');
    host.setAttribute?.('aria-disabled', 'true');
    if (
      typeof host.matches === 'function' &&
      host.matches('button,input,select,textarea')
    )
      count += disableControl(host);
    for (const control of host.querySelectorAll?.(
      'button, input, select, textarea',
    ) ?? [])
      count += disableControl(control);
  }
  return count;
}
