// Optional wording for one inspection finding.
//
// The Sentinel's findings are built deterministically in the layer's own
// language (see index.js): the spider always says what it read, with or
// without a model. This module is the only place a model is asked, and it is
// asked for one thing — a single sentence — never for a plan:
//   - only a finding that matters (a warning, not a calm inspection) is worth
//     spending on, at most once every BRIEF_MIN_INTERVAL_MS, and the layer
//     decides that before calling here,
//   - the same-origin relays keep the operator's credential server-side; a
//     keyless relay answers 503 `not-configured`, which is a normal answer
//     here: the caller keeps its deterministic sentence and nothing is spent,
//   - actions in the answer are ignored on purpose. The spider inspects; it
//     does not drive the operator's layers or camera.
// @module layers/aiAgent/brief

/** OpenAI first; the Gemini relay is the automatic fallback, as before. */
export const BRIEF_URLS = Object.freeze([
  '/api/openai/agent-plan',
  '/api/gemini/agent-plan',
]);

/** One sentence, not a paragraph. */
export const MAX_BRIEF_CHARS = 220;

/** At most one paid sentence in this window. */
export const BRIEF_MIN_INTERVAL_MS = 20 * 60 * 1000;

/**
 * A relay status that ends the attempt without trying the fallback: the
 * local per-IP budget already decided not to spend, and repaying the same
 * packet to a second provider would turn a throttle into double spend.
 */
const NO_FALLBACK_STATUS = new Set([429]);

/**
 * The request both relays accept: `{instructions, input}` in, `{plan}` out.
 * The instructions keep the model inside the envelope the relay parses.
 *
 * @param {{layer:string, count:number, severity:string, error?:string,
 *   at?:number}} finding what the spider just read.
 * @param {{locale?:string}} [context] the operator's language, so the
 *   sentence arrives in it.
 * @returns {{instructions:string, input:object}}
 */
export function buildBriefRequest(finding, { locale = 'en' } = {}) {
  return {
    instructions: [
      'You are Sentinel, the watch spider on a live world map.',
      'You are given ONE finding the spider has just made while walking the globe:',
      'the layer it inspected, how many records that layer holds, its severity,',
      'and the feed error when the feed is down.',
      'Write ONE short sentence (at most 25 words) telling the operator what it found.',
      'Use only the given numbers and facts; never invent places, events or causes.',
      `Answer in the language whose code is ${locale}.`,
      'Answer ONLY JSON: {"speech": string, "actions": []}',
    ].join(' '),
    input: {
      finding: {
        layer: String(finding?.layer ?? ''),
        records: Number.isFinite(Number(finding?.count))
          ? Number(finding.count)
          : 0,
        severity: String(finding?.severity ?? 'info'),
        ...(finding?.error ? { feedError: String(finding.error) } : {}),
      },
      locale,
    },
  };
}

/**
 * Pull the sentence out of a relay's `{plan}` envelope.
 *
 * Anything that is not a usable single line is null: the caller then keeps
 * the deterministic finding rather than showing half an answer.
 *
 * @param {unknown} data the relay's JSON body.
 * @returns {string|null}
 */
export function shapeBrief(data) {
  const speech = data?.plan?.speech;
  if (typeof speech !== 'string') return null;
  const line = speech
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!line) return null;
  return line.slice(0, MAX_BRIEF_CHARS);
}

/**
 * Ask a relay to word one finding.
 *
 * @param {object} finding see buildBriefRequest.
 * @param {{locale?:string, fetchImpl?:Function}} [options]
 * @returns {Promise<string|null>} the sentence, or null when no relay could
 *   word it — the caller's deterministic text is always the fallback.
 */
export async function requestFindingBrief(
  finding,
  { locale = 'en', fetchImpl = fetch } = {},
) {
  const payload = buildBriefRequest(finding, { locale });
  const request = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
  for (const url of BRIEF_URLS) {
    try {
      const response = await fetchImpl(url, request);
      if (NO_FALLBACK_STATUS.has(response.status)) return null;
      if (response.ok) {
        const brief = shapeBrief(await response.json().catch(() => null));
        if (brief) return brief;
        // A 200 without a usable sentence is a model answer, not a relay
        // failure: asking the other provider would spend again for nothing.
        return null;
      }
      // A non-ok relay (a keyless 503, an upstream error) falls through.
    } catch {
      // Relay unreachable: fall through to the next provider.
    }
  }
  return null;
}
