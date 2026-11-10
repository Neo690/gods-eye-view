// The Sentinel's voice: one spoken line per GhostMaps alert.
//
// The tour already flies to an alert and opens its detailed card, which is
// silent — the operator watching the globe has to read. This module says the
// same headline out loud when the tour reaches it:
//   - it uses the device's own synthesiser (`speechSynthesis`), so it costs
//     nothing, needs no key and no server, and speaks the operator's language
//     through the installed engine. The Gemini voice in this app is a live
//     microphone session, not a text-to-speech endpoint; it is not used here,
//   - one sentence per alert, and a new alert cancels the previous sentence:
//     the tour moves on, so the old headline is stale rather than queued,
//   - a muted voice, an empty line, a missing synthesiser or a synthesiser
//     that throws is a normal answer. Speaking is theatre; the card keeps the
//     facts either way.
// The layer decides WHEN to speak (see index.js); this module only owns the
// utterance and the mute.
// @module layers/aiAgent/voice

/** An announcement is a headline, not the whole popup table. */
export const MAX_ALERT_SPEECH_CHARS = 180;

/**
 * @param {object} [options]
 * @param {SpeechSynthesis} [options.speech] synthesiser seam; defaults to the
 *   page's `speechSynthesis` at call time, so a layer created before the
 *   document is ready still finds it.
 * @param {Function} [options.utterance] `SpeechSynthesisUtterance` seam.
 * @param {() => string} [options.locale] the language to speak in.
 * @returns {{announce: (text: string) => boolean, setEnabled: Function,
 *   isEnabled: () => boolean, stop: Function, destroy: Function}}
 */
export function createAlertVoice({
  speech = undefined,
  utterance = undefined,
  locale = () => 'en',
} = {}) {
  let enabled = true;
  let destroyed = false;

  const synthesizer = () =>
    speech ?? globalThis.speechSynthesis ?? globalThis.window?.speechSynthesis;
  const Utterance = () =>
    utterance ??
    globalThis.SpeechSynthesisUtterance ??
    globalThis.window?.SpeechSynthesisUtterance;

  function stop() {
    try {
      synthesizer()?.cancel?.();
    } catch {
      // An engine torn down with its page cannot take a cancellation.
    }
  }

  /**
   * Read one alert line aloud. Returns whether the engine was asked to speak;
   * false is the ordinary answer for a muted voice or a silent device.
   * @param {string} text
   * @returns {boolean}
   */
  function announce(text) {
    if (destroyed || !enabled) return false;
    const line = String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_ALERT_SPEECH_CHARS);
    if (!line) return false;
    const engine = synthesizer();
    const UtteranceClass = Utterance();
    if (
      typeof engine?.speak !== 'function' ||
      typeof UtteranceClass !== 'function'
    )
      return false;
    try {
      // The tour has moved on: the previous headline is stale, not queued.
      engine.cancel?.();
      const spoken = new UtteranceClass(line);
      try {
        spoken.lang = String(locale?.() || 'en');
      } catch {
        // A locale read that fails leaves the engine's default language.
      }
      engine.speak(spoken);
      return true;
    } catch {
      return false;
    }
  }

  return {
    announce,
    stop,
    isEnabled: () => enabled,
    setEnabled(next) {
      enabled = Boolean(next);
      // Muting mid-sentence silences the sentence too, not just the next one.
      if (!enabled) stop();
    },
    destroy() {
      destroyed = true;
      stop();
    },
  };
}
