// src/ui/dictation.js
//
// Command dictation: the phone's own speech recogniser as a command source.
//
// This is deliberately not a voice provider. A dictation session mints no
// token, opens no socket and costs nothing: the Android shell runs the
// platform recogniser and posts the transcript back, and the transcript goes
// to the command palette, which already knows how to run a layer, a panel or a
// place. Anything that needs a model — questions, context, multi-step plans —
// stays with the voice providers; this mode exists so a phone can issue a
// command with no key, no server and no bill.
import { t } from '../i18n/index.js';

/** The shell method the Android app exposes; absent in a browser or on desktop. */
export const DICTATION_METHOD = 'dictate';

/** How long a press may stay lit with no answer from the shell. */
export const DICTATION_SILENCE_MS = 12_000;

/**
 * Whether this build can dictate at all.
 * @param {object} [bridge] the shell bridge (globalThis.GodsEyeNative)
 * @returns {boolean}
 */
export function dictationAvailable(bridge) {
  return typeof bridge?.[DICTATION_METHOD] === 'function';
}

/** One sentence per way dictation can fail; unknown codes get the generic one. */
export function dictationMessage(code) {
  switch (String(code || '')) {
    case 'permission':
      return t('Dictation needs the microphone permission.');
    case 'network':
      return t('Dictation needs a network connection on this device.');
    case 'language':
      return t('The phone cannot dictate in this language.');
    case 'no_match':
    case 'timeout':
      return t('Nothing was heard. Try again.');
    default:
      return t('Dictation is not available on this device.');
  }
}

/**
 * What one native dictation event means to the console.
 *
 * The shell speaks first: 'listening' when the recogniser starts, 'partial'
 * while it hears, then exactly one of 'final' or 'error'. The states that carry
 * no text are progress, not outcomes.
 *
 * @param {{status?: string, text?: string, message?: string}} [event]
 * @returns {{action: 'ignore'|'command'|'toast', text?: string, message?: string}}
 */
export function dictationOutcome(event) {
  const status = typeof event?.status === 'string' ? event.status : '';
  const text = typeof event?.text === 'string' ? event.text.trim() : '';
  if (status === 'final')
    return text
      ? { action: 'command', text }
      : { action: 'toast', message: dictationMessage('no_match') };
  if (status === 'error')
    return { action: 'toast', message: dictationMessage(event?.message) };
  return { action: 'ignore' };
}

/**
 * Wire the dictation button to the shell and the palette.
 *
 * Returns null when the shell has no recogniser, which is the normal case in a
 * browser, on the desktop build and on any APK that predates this mode: the
 * button then stays hidden and nothing behaves differently.
 *
 * @param {object} [options]
 * @param {HTMLElement} [options.button] the dictation button
 * @param {object} [options.bridge] the shell bridge
 * @param {Function} [options.openPalette] (text) => void
 * @param {Function} [options.toast] (text) => void
 * @param {Document} [options.documentRef]
 * @param {Function} [options.locale] () => BCP-47 tag for the recogniser
 * @param {number} [options.silenceMs] how long an unanswered press stays lit
 * @returns {{handle: Function, destroy: Function}|null}
 */
export function createDictation({
  button = null,
  bridge = globalThis.GodsEyeNative,
  openPalette = () => {},
  toast = () => {},
  documentRef = globalThis.document,
  locale = () => documentRef?.documentElement?.getAttribute?.('lang') || '',
  silenceMs = DICTATION_SILENCE_MS,
} = {}) {
  if (!button || !dictationAvailable(bridge)) return null;
  let busy = false;
  let answered = false;
  let silence = null;

  const paint = (value) => {
    busy = value;
    button.setAttribute('aria-busy', String(value));
  };

  /** The shell's own callback; the page exposes it as window.__gevDictation. */
  const handle = (event) => {
    const outcome = dictationOutcome(event);
    if (outcome.action === 'ignore') {
      if (event?.status === 'listening') {
        answered = true;
        paint(true);
      }
      return;
    }
    answered = true;
    paint(false);
    if (outcome.action === 'command') openPalette(outcome.text);
    else toast(outcome.message);
  };

  const onClick = () => {
    if (busy) return;
    answered = false;
    paint(true);
    try {
      bridge[DICTATION_METHOD](locale() || '');
    } catch (error) {
      paint(false);
      toast(dictationMessage('start_failed'));
      return;
    }
    // An APK that exposes the method but answers nothing must not leave the
    // button lit forever; a shell that did answer keeps its own state.
    clearTimeout(silence);
    silence = setTimeout(() => {
      if (!answered) paint(false);
    }, silenceMs);
  };

  button.hidden = false;
  button.addEventListener('click', onClick);
  return {
    handle,
    destroy() {
      clearTimeout(silence);
      button.removeEventListener('click', onClick);
      button.hidden = true;
      paint(false);
    },
  };
}
