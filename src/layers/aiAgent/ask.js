// The Sentinel's ASK mode: local questions about the GhostMaps alerts.
//
// The tour already narrates one headline at a time; this answers a question the
// operator asks out loud — the most severe alert, the next one, how many are
// loaded, or the last answer again. Everything is computed from the alerts the
// GhostMaps layer already holds:
//   - no model, no key, no network. A transcript is matched against a small
//     keyword table and the answer is assembled from the alert rows, so the
//     feature costs nothing and works with every provider switched off,
//   - the alert order is the layer's own severity ranking (getSentinelAlerts),
//     so "the next one" means the next stop of the tour, not a second sort,
//   - the keyword table covers every shipped language, because the device
//     recogniser transcribes in the operator's language, not in English,
//   - the state is only a cursor (which alert was read last) and the last
//     answer, so "repeat" is exact and crossing the end wraps to the most
//     severe alert instead of inventing a fifth answer.
// The layer owns WHEN to ask and what to do with the text (speak it, show it);
// this module owns what a question means and what the answer says.
// @module layers/aiAgent/ask
import { t, tn, formatNumber } from '../../i18n/index.js';

/** The questions the mode understands. */
export const ASK_INTENTS = Object.freeze(['worst', 'next', 'total', 'repeat']);

/**
 * Spoken forms per intent, already normalized by `normalizeQuestion`.
 * Several languages can share a word ("total"), and a phrase only has to be
 * contained in the transcript: recognisers add articles and punctuation.
 */
const ASK_WORDS = Object.freeze({
  worst: Object.freeze([
    'plus grave',
    'la pire',
    'le pire',
    'plus dangereuse',
    'most severe',
    'most dangerous',
    'the worst',
    'worst',
    'mas grave',
    'la peor',
    'peor alerta',
    'самая серьезная',
    'самая опасная',
    'худшая',
    '最严重',
    '最危险',
    'الاخطر',
    'الاشد',
  ]),
  next: Object.freeze([
    'suivante',
    'prochaine',
    'next',
    'siguiente',
    'proxima',
    'следующая',
    'дальше',
    '下一个',
    '下一条',
    'التالي',
    'التالية',
  ]),
  total: Object.freeze([
    'total',
    'combien',
    'nombre',
    'how many',
    'count',
    'cuantas',
    'cuantos',
    'сколько',
    'всего',
    '多少',
    '总数',
    'كم',
    'الاجمالي',
  ]),
  repeat: Object.freeze([
    'repete',
    'repeter',
    'encore',
    'repeat',
    'again',
    'repite',
    'otra vez',
    'повтори',
    'еще раз',
    '重复',
    'اعد',
    'كرر',
  ]),
});

/**
 * Lower-case, unaccented, letters-and-digits text. Arabic alef and ta marbuta
 * are folded so a transcript written with different glyphs still matches.
 * @param {string} text
 * @returns {string}
 */
export function normalizeQuestion(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * What a transcript is asking for, or null when it is none of the four.
 * An explicit question wins over a stray keyword: the table is checked in the
 * order the answers are listed, so "la plus grave" is never read as "next".
 * @param {string} text
 * @returns {'worst'|'next'|'total'|'repeat'|null}
 */
export function readAskIntent(text) {
  const said = normalizeQuestion(text);
  if (!said) return null;
  for (const intent of ASK_INTENTS) {
    const words = ASK_WORDS[intent];
    if (words.some((word) => said.includes(normalizeQuestion(word)))) {
      return intent;
    }
  }
  return null;
}

/** One alert as a spoken sentence: headline first, then where it is. */
function describeAlert(alert) {
  const summary = String(alert?.summary || alert?.name || '').trim();
  const folder = String(alert?.folder || '').trim();
  const parts = [summary || t('Report')];
  if (folder && !summary.toLowerCase().includes(folder.toLowerCase())) {
    parts.push(folder);
  }
  return parts.filter(Boolean).join(' · ');
}

/**
 * The alert answerer. Keeps only what "next" and "repeat" need, so the layer
 * can hold one of these for its whole life.
 * @returns {{answer: Function, reset: Function}}
 */
export function createAlertAnswerer() {
  let lastText = '';
  let cursorId = null;

  function remember(result) {
    lastText = result.text;
    return result;
  }

  /**
   * @param {Array<object>} alerts ranked most severe first
   * @param {'worst'|'next'|'total'|'repeat'|null} intent
   * @returns {{intent: string|null, text: string, alertId: string|null}}
   */
  function answer(alerts, intent) {
    const rows = Array.isArray(alerts) ? alerts : [];

    // "Repeat" is the only answer that works with no alerts at all: it repeats
    // the last sentence, whatever that was.
    if (intent === 'repeat') {
      return {
        intent: 'repeat',
        text: lastText || t('Nothing to repeat yet.'),
        alertId: null,
      };
    }

    if (!rows.length) {
      return remember({
        intent: intent || null,
        text: t('No GhostMaps alerts are loaded yet.'),
        alertId: null,
      });
    }

    if (intent === 'total') {
      const count = rows.length;
      const emergencies = rows.filter(
        (alert) => alert?.severity === 'emergency',
      ).length;
      const loaded = tn(
        count,
        '{count} alert loaded',
        '{count} alerts loaded',
        { count: formatNumber(count) },
      );
      const urgent = emergencies
        ? ` · ${tn(emergencies, '{count} emergency', '{count} emergencies', {
            count: formatNumber(emergencies),
          })}`
        : '';
      return remember({
        intent: 'total',
        text: `${loaded}${urgent}`,
        alertId: null,
      });
    }

    if (intent === 'worst' || intent === 'next') {
      let index = 0;
      if (intent === 'next' && cursorId !== null) {
        const at = rows.findIndex((alert) => String(alert?.id) === cursorId);
        if (at >= 0) index = (at + 1) % rows.length;
      }
      const alert = rows[index];
      const alertId = String(alert?.id ?? '');
      const detail = describeAlert(alert);
      cursorId = alertId;
      // Two literals, not one ternary: the i18n extractor only sees a
      // message in the first argument itself.
      const text =
        intent === 'worst'
          ? t('Most severe: {alert}', { alert: detail })
          : t('Next: {alert}', { alert: detail });
      return remember({ intent, text, alertId });
    }

    // A question none of the four covers: say what can be asked instead of
    // guessing at an alert.
    return remember({
      intent: null,
      text: t(
        'I can tell you the most severe alert, the next one, the total, or repeat the last one.',
      ),
      alertId: null,
    });
  }

  return {
    answer,
    reset() {
      lastText = '';
      cursorId = null;
    },
  };
}
