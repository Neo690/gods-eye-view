// Sentinel report card.
//
// The spider itself crawls on the globe (spider.js); this is the little card
// it writes to, in the corner the old avatar occupied: its state glow, the
// latest finding and a collapsible list of what it inspected. It mounts on
// document body (never inside the Cesium canvas) so a globe drag or a pick can
// never reach it.
//
// The card is built node by node behind a `doc` seam: a node test drives the
// same view with a small DOM double, and a document-less run gets no card at
// all rather than a throw. Labels are translated here, at creation, because
// the boot-time document pass has already run by the time the layer mounts.
import { t, formatRelativeTime } from '../../i18n/index.js';
import { eventSeverity } from './watch.js';

const FEED_LIMIT = 12;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** One severity → one glow colour class on the badge. */
const STATE_CLASS = {
  idle: 'idle',
  info: 'calm',
  warn: 'alert',
  emergency: 'emergency',
};

/** The eight legs, as path data in the glyph's 64 × 64 box. */
const LEG_PATHS = Object.freeze([
  'M27 31 L17 24 L11 27',
  'M27 37 L15 36 L9 41',
  'M28 43 L17 47 L12 54',
  'M30 48 L25 55 L26 61',
  'M37 31 L47 24 L53 27',
  'M37 37 L49 36 L55 41',
  'M36 43 L47 47 L52 54',
  'M34 48 L39 55 L38 61',
]);

/** Small attribute helper: `setAttribute` when the node has it. */
function attr(node, name, value) {
  if (typeof node?.setAttribute === 'function') node.setAttribute(name, value);
  return node;
}

/**
 * The robot spider: eight angular legs, a two-part body, one sensor eye.
 * Without `createElementNS` (a minimal test double) it degrades to a glyph
 * character, which is what a card without an SVG would show anyway.
 * @param {Document} document
 * @returns {Element}
 */
function spiderGlyph(document) {
  if (typeof document.createElementNS !== 'function') {
    const fallback = document.createElement('span');
    fallback.className = 'gev-ai-agent-figure';
    fallback.textContent = '🕷';
    return fallback;
  }
  // SVG nodes spell their class as an attribute: `element.className` is a
  // read-only SVGAnimatedString there, so it is never assigned.
  const svg = attr(
    document.createElementNS(SVG_NS, 'svg'),
    'viewBox',
    '0 0 64 64',
  );
  attr(svg, 'class', 'gev-ai-agent-figure');
  attr(svg, 'aria-hidden', 'true');
  // The legs carry their own group so the whole eight can tread in place.
  const legs = attr(
    document.createElementNS(SVG_NS, 'g'),
    'class',
    'gev-ai-agent-legs',
  );
  for (const d of LEG_PATHS) {
    const path = attr(document.createElementNS(SVG_NS, 'path'), 'd', d);
    legs.appendChild(path);
  }
  svg.appendChild(legs);
  const abdomen = attr(document.createElementNS(SVG_NS, 'ellipse'), 'cx', '32');
  attr(abdomen, 'cy', '37');
  attr(abdomen, 'rx', '9');
  attr(abdomen, 'ry', '10');
  svg.appendChild(abdomen);
  const head = attr(document.createElementNS(SVG_NS, 'circle'), 'cx', '32');
  attr(head, 'cy', '24');
  attr(head, 'r', '7');
  svg.appendChild(head);
  const eye = attr(document.createElementNS(SVG_NS, 'circle'), 'cx', '32');
  attr(eye, 'cy', '22');
  attr(eye, 'r', '2');
  attr(eye, 'class', 'gev-ai-agent-eye');
  svg.appendChild(eye);
  return svg;
}

/** The microphone of ASK mode: a capsule, an arc and a stand. */
function micGlyph(document) {
  if (typeof document.createElementNS !== 'function') {
    const fallback = document.createElement('span');
    attr(fallback, 'aria-hidden', 'true');
    fallback.textContent = '🎙';
    return fallback;
  }
  const svg = attr(
    document.createElementNS(SVG_NS, 'svg'),
    'viewBox',
    '0 0 24 24',
  );
  attr(svg, 'class', 'gev-ai-agent-mic');
  attr(svg, 'aria-hidden', 'true');
  const capsule = attr(document.createElementNS(SVG_NS, 'rect'), 'x', '9');
  attr(capsule, 'y', '3');
  attr(capsule, 'width', '6');
  attr(capsule, 'height', '11');
  attr(capsule, 'rx', '3');
  svg.appendChild(capsule);
  const arc = attr(
    document.createElementNS(SVG_NS, 'path'),
    'd',
    'M5 11a7 7 0 0 0 14 0',
  );
  svg.appendChild(arc);
  const stem = attr(document.createElementNS(SVG_NS, 'path'), 'd', 'M12 20v2');
  svg.appendChild(stem);
  return svg;
}

/**
 * Build (or reuse) the report card.
 *
 * @param {object} [repos]
 * @param {Document} [repos.doc] document seam.
 * @param {Element} [repos.host] host appends the root.
 * @param {Function} [repos.onAskStart] a held ASK microphone was pressed.
 * @param {Function} [repos.onAskEnd] the held press was released.
 * @param {Function} [repos.onAskCancel] the held press was dropped.
 * @returns {object|null} view with setState/pushEvent/setAskMode/setAnswer/
 *   setSleeping/destroy.
 */
export function createAvatarOverlay({
  doc = undefined,
  host = undefined,
  onAskStart = () => {},
  onAskEnd = () => {},
  onAskCancel = () => {},
} = {}) {
  const document = doc ?? globalThis.document;
  if (!document || typeof document.createElement !== 'function') return null;
  const root = document.createElement('div');
  root.className = 'gev-ai-agent';
  attr(root, 'data-state', 'idle');

  const box = document.createElement('div');
  box.className = 'gev-ai-agent-avatar';
  box.appendChild(spiderGlyph(document));

  const toggle = document.createElement('button');
  toggle.className = 'gev-ai-agent-toggle';
  attr(toggle, 'type', 'button');
  attr(toggle, 'aria-label', t('Sentinel'));
  attr(toggle, 'aria-expanded', 'false');
  attr(toggle, 'aria-controls', 'gev-ai-agent-feed');
  box.appendChild(toggle);

  // ASK mode's push-to-talk button and the answer it produces. Both stay out
  // of the card until the mode is switched on from the layer row.
  const ask = document.createElement('button');
  ask.className = 'gev-ai-agent-ask';
  attr(ask, 'type', 'button');
  attr(ask, 'aria-label', t('Ask the Sentinel'));
  attr(
    ask,
    'title',
    t(
      'Hold to ask about the alerts: the most severe, the next one, the total, or repeat',
    ),
  );
  attr(ask, 'data-listening', 'false');
  ask.hidden = true;
  ask.appendChild(micGlyph(document));

  const answer = document.createElement('div');
  answer.className = 'gev-ai-agent-answer';
  attr(answer, 'role', 'status');
  attr(answer, 'aria-live', 'polite');
  answer.hidden = true;

  const bubble = document.createElement('div');
  bubble.className = 'gev-ai-agent-bubble';
  bubble.hidden = true;

  const feed = document.createElement('div');
  feed.className = 'gev-ai-agent-feed';
  attr(feed, 'id', 'gev-ai-agent-feed');
  feed.hidden = true;

  root.appendChild(box);
  root.appendChild(ask);
  root.appendChild(answer);
  root.appendChild(bubble);
  root.appendChild(feed);
  (host || document.body).appendChild(root);

  let expanded = false;
  let destroyed = false;
  let askMode = false;
  let pressing = false;

  function syncExpanded() {
    bubble.hidden = !expanded || !bubble.textContent;
    feed.hidden = !expanded;
    attr(toggle, 'aria-expanded', String(expanded));
    root.classList.toggle?.('expanded', expanded);
  }

  toggle.addEventListener?.('click', () => {
    expanded = !expanded;
    syncExpanded();
  });

  // A press is the question, a release is the end of it. The pointer is
  // captured so a release outside the button still closes the microphone.
  const startAsk = (event) => {
    if (destroyed || !askMode || pressing) return;
    event?.preventDefault?.();
    pressing = true;
    attr(ask, 'data-listening', 'true');
    try {
      ask.setPointerCapture?.(event?.pointerId);
    } catch {
      // A pointer id the browser no longer knows cannot be captured.
    }
    onAskStart?.();
  };

  const endAsk = (event) => {
    if (!pressing) return;
    event?.preventDefault?.();
    pressing = false;
    attr(ask, 'data-listening', 'false');
    onAskEnd?.();
  };

  const cancelAsk = () => {
    if (!pressing) return;
    pressing = false;
    attr(ask, 'data-listening', 'false');
    onAskCancel?.();
  };

  ask.addEventListener?.('pointerdown', startAsk);
  ask.addEventListener?.('pointerup', endAsk);
  ask.addEventListener?.('pointercancel', cancelAsk);
  ask.addEventListener?.('lostpointercapture', () => {
    if (pressing) endAsk();
  });
  ask.addEventListener?.('keydown', (event) => {
    if (event?.key === ' ' || event?.key === 'Enter') startAsk(event);
  });
  ask.addEventListener?.('keyup', (event) => {
    if (event?.key === ' ' || event?.key === 'Enter') endAsk(event);
  });
  ask.addEventListener?.('blur', cancelAsk);

  const severityWord = {
    info: t('calm'),
    warn: t('attention'),
    emergency: t('alert'),
  };

  return {
    get visible() {
      return !destroyed && !root.hidden;
    },

    /** Severity word drives the glow; 'idle' turns the spider translucent. */
    setState(severity) {
      if (destroyed) return;
      const state = STATE_CLASS[severity] || 'idle';
      attr(root, 'data-state', state);
      toggle.title =
        severity === 'idle'
          ? t('Sentinel: standby')
          : t('Sentinel: {state}', {
              state: severityWord[severity] || severityWord.info,
            });
    },

    /** Pool one finding and refresh the surfaces that show it. */
    pushEvent(event) {
      if (destroyed || !event) return;
      const severity = eventSeverity(event);
      const title = [event.label || event.layerId || '', event.detail || '']
        .filter(Boolean)
        .join(' — ');
      const when = Number.isFinite(Number(event.at))
        ? formatRelativeTime(-(Date.now() - Number(event.at)) / 1000, 'second')
        : '';
      const row = document.createElement('div');
      row.className = `gev-ai-agent-row sev-${severity}`;
      row.textContent = title;
      attr(row, 'title', t('{title} · {when}', { title, when }));
      feed.prepend?.(row);
      while (
        typeof feed.lastElementChild !== 'undefined' &&
        feed.childElementCount > FEED_LIMIT
      )
        feed.lastElementChild.remove();
      bubble.textContent = title;
      bubble.hidden = !expanded;
    },

    /** ASK mode: the held microphone appears, and leaves with the mode. */
    setAskMode(value) {
      if (destroyed) return;
      askMode = Boolean(value);
      ask.hidden = !askMode;
      if (!askMode) {
        pressing = false;
        attr(ask, 'data-listening', 'false');
        answer.textContent = '';
        answer.hidden = true;
      }
      root.classList.toggle?.('asking', askMode);
    },

    /** The answer to a question, readable without a speaker. */
    setAnswer(text) {
      if (destroyed) return;
      const line = String(text ?? '').trim();
      answer.textContent = line;
      answer.hidden = !askMode || !line;
    },

    /** Dormant layer: keep the badge but grey it out and close the card. */
    setSleeping(asleep) {
      if (destroyed) return;
      root.classList.toggle?.('asleep', Boolean(asleep));
      if (asleep) expanded = false;
      syncExpanded();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      root.remove?.();
    },
  };
}
