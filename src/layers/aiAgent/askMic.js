// The Sentinel's held microphone.
//
// ASK mode is one gesture: hold the button, say a question, let go. This module
// owns that gesture's input side only — the transcript still goes to ask.js,
// which answers from local alert data.
//   - the Android app exposes `GodsEyeNative.askDictate`. Its recogniser answers
//     through `window.__gevAskDictation`, a channel of its own, so a question
//     never reaches the palette's dictation button and never opens the command
//     palette. `dictateStop` finalizes on release; `dictateCancel` drops the
//     press without a transcript,
//   - a browser with the Web Speech API answers through `SpeechRecognition`.
//     A final result ends the question; otherwise releasing the button asks the
//     engine to finish,
//   - an old shell without `askDictate` is deliberately NOT driven through
//     `dictate`: that event would open the palette. On such an APK the mode is
//     absent rather than broken,
//   - an unanswered press gives up after a bounded wait, so a shell that never
//     replies cannot leave the button listening forever.
// Nothing here records, stores or sends audio beyond the platform's own
// recogniser; the answer is local and costs nothing.
// @module layers/aiAgent/askMic

/** How long a held press may stay open with no answer from the recogniser. */
export const ASK_MIC_SILENCE_MS = 15_000;

/** The page's Web Speech constructor, if this browser ships one. */
function recognitionConstructor(scope) {
  return scope?.SpeechRecognition ?? scope?.webkitSpeechRecognition ?? null;
}

/**
 * Whether this build can capture a held question at all.
 * @param {{bridge?: object, scope?: object}} [options] test seams
 * @returns {boolean}
 */
export function askSpeechAvailable({
  bridge = undefined,
  scope = undefined,
} = {}) {
  const shell = bridge === undefined ? globalThis.GodsEyeNative : bridge;
  const view = scope ?? globalThis;
  return (
    typeof shell?.askDictate === 'function' ||
    typeof recognitionConstructor(view) === 'function'
  );
}

/**
 * One push-to-talk input. The caller starts it on press, stops it on release
 * and gets exactly one of `onTranscript` or `onError` per press.
 *
 * @param {object} [options]
 * @param {object} [options.bridge] native shell seam (defaults to
 *   `globalThis.GodsEyeNative` at call time).
 * @param {object} [options.scope] global object seam for the recogniser and the
 *   `__gevAskDictation` callback.
 * @param {() => string} [options.locale] language to listen in.
 * @param {(text: string) => void} [options.onTranscript] the heard question.
 * @param {(code: string) => void} [options.onError] why nothing was heard.
 * @param {number} [options.silenceMs] how long an unanswered press stays open.
 * @returns {{available: boolean, start: Function, stop: Function,
 *   cancel: Function, destroy: Function}}
 */
export function createAskMic({
  bridge = undefined,
  scope = undefined,
  locale = () => 'en',
  onTranscript = () => {},
  onError = () => {},
  silenceMs = ASK_MIC_SILENCE_MS,
} = {}) {
  const shell = bridge === undefined ? globalThis.GodsEyeNative : bridge;
  const view = scope ?? globalThis;
  const native = typeof shell?.askDictate === 'function' ? shell : null;
  const Recognition = recognitionConstructor(view);
  const available = Boolean(native || Recognition);

  let active = false;
  let destroyed = false;
  let live = null;
  let silence = null;

  /** Deliver the one outcome of a press, whichever end produced it. */
  function finish(text, error = 'no_match') {
    if (!active) return;
    active = false;
    if (silence) {
      clearTimeout(silence);
      silence = null;
    }
    const line = String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (live) {
      const current = live;
      live = null;
      try {
        current.abort?.();
      } catch {
        // A recogniser torn down with its page cannot take another abort.
      }
    }
    if (line) onTranscript(line);
    else onError(String(error || 'no_match'));
  }

  /** One native event; progress is not an outcome. */
  const hearNative = (event) => {
    if (!active) return;
    const status = String(event?.status || '');
    if (status === 'final') finish(event?.text);
    else if (status === 'error') finish('', event?.message || 'error');
  };

  if (native) view.__gevAskDictation = hearNative;

  function start() {
    if (destroyed || active || !available) return false;
    active = true;
    silence = setTimeout(
      () => {
        if (active) finish('', 'no_match');
      },
      Math.max(0, Number(silenceMs) || 0),
    );

    if (native) {
      try {
        // A palette dictation in flight must not keep the microphone.
        native.dictateCancel?.();
        native.askDictate(String(locale?.() || ''));
        return true;
      } catch {
        finish('', 'start_failed');
        return false;
      }
    }

    try {
      live = new Recognition();
      live.lang = String(locale?.() || 'en');
      live.continuous = true;
      live.interimResults = true;
      live.maxAlternatives = 1;
      live.onresult = (event) => {
        let heard = '';
        const results = event?.results ?? [];
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (!result?.isFinal) continue;
          const line = result?.[0]?.transcript;
          if (typeof line === 'string') heard += ` ${line}`;
        }
        if (heard.trim()) finish(heard);
      };
      live.onerror = (event) => {
        // Aborting our own recogniser after a result is not a failure.
        if (event?.error === 'aborted') return;
        finish('', event?.error === 'no-speech' ? 'no_match' : 'error');
      };
      live.onend = () => {
        live = null;
        if (active) finish('', 'no_match');
      };
      live.start();
      return true;
    } catch {
      live = null;
      finish('', 'start_failed');
      return false;
    }
  }

  function stop() {
    if (!active) return false;
    if (native) {
      try {
        native.dictateStop?.();
      } catch {
        finish('', 'error');
      }
      return true;
    }
    try {
      live?.stop?.();
    } catch {
      finish('', 'error');
    }
    return true;
  }

  function cancel() {
    const wasActive = active;
    active = false;
    if (silence) {
      clearTimeout(silence);
      silence = null;
    }
    // Only a press this control opened may be cancelled: the shell has one
    // recogniser, and a palette dictation in flight is not ours to end.
    if (wasActive && native) {
      try {
        native.dictateCancel?.();
      } catch {
        // A bridge torn down with its activity cannot take a cancellation.
      }
    }
    if (live) {
      const current = live;
      live = null;
      try {
        current.abort?.();
      } catch {
        // A recogniser torn down with its page cannot take another abort.
      }
    }
    return wasActive;
  }

  return {
    get available() {
      return available && !destroyed;
    },
    start,
    stop,
    cancel,
    destroy() {
      if (destroyed) return;
      cancel();
      destroyed = true;
      if (native && view.__gevAskDictation === hearNative) {
        try {
          delete view.__gevAskDictation;
        } catch {
          view.__gevAskDictation = undefined;
        }
      }
    },
  };
}
