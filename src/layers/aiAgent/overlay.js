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

/**
 * Build (or reuse) the report card.
 *
 * @param {{doc?: Document, host?: Element}} [repos] host appends the root.
 * @returns {object|null} view with setState/pushEvent/setSleeping/destroy.
 */
export function createAvatarOverlay({
  doc = undefined,
  host = undefined,
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

  const bubble = document.createElement('div');
  bubble.className = 'gev-ai-agent-bubble';
  bubble.hidden = true;

  const feed = document.createElement('div');
  feed.className = 'gev-ai-agent-feed';
  attr(feed, 'id', 'gev-ai-agent-feed');
  feed.hidden = true;

  root.appendChild(box);
  root.appendChild(bubble);
  root.appendChild(feed);
  (host || document.body).appendChild(root);

  let expanded = false;
  let destroyed = false;

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
