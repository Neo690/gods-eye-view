// Translucent AI-agent avatar overlay.
//
// The avatar is pure DOM: a translucent human silhouette with a state glow,
// a latest-event bubble and a collapsible alert feed. It mounts on document
// body (never inside the Cesium canvas) so a globe drag or a pick can never
// reach it, and it stays out of the map's centre: fixed to the bottom corner
// by the stylesheet, collapsible to a single orb.
import { t, formatRelativeTime } from '../../i18n/index.js';
import { eventSeverity } from './watch.js';

const FEED_LIMIT = 12;

/** One severity → one glow colour class on the orb. */
const STATE_CLASS = {
  idle: 'idle',
  info: 'calm',
  warn: 'alert',
  emergency: 'emergency',
};

/**
 * Build (or reuse) the avatar overlay. All DOM access is behind `doc` so a
 * node-test can drive the same view without a browser.
 * @param {{doc?: Document, host?: Element}} [repos] host appends the root.
 * @returns {object} view with show/hide/setState/pushEvent/renderFeed/destroy.
 */
export function createAvatarOverlay({ doc = undefined, host = undefined } = {}) {
  const document = doc ?? globalThis.document;
  if (!document) return null;
  const root = document.createElement('div');
  root.className = 'gev-ai-agent';
  root.dataset.state = 'idle';
  root.innerHTML = [
    '<div class="gev-ai-agent-avatar">',
    '<svg class="gev-ai-agent-figure" viewBox="0 0 64 64" aria-hidden="true">',
    '<circle cx="32" cy="17" r="9"/>',
    '<path d="M32 28c-10 0-17 7-17 16v10h34v-10c0-9-7-16-17-16z"/>',
    '</svg>',
    '<button class="gev-ai-agent-toggle" type="button" data-i18n-aria-label="AI Agent',
    '" aria-expanded="false" aria-controls="gev-ai-agent-feed"></button>',
    '<span class="gev-ai-agent-rate"></span>',
    '</div>',
    '<div class="gev-ai-agent-bubble" hidden></div>',
    '<div class="gev-ai-agent-feed" id="gev-ai-agent-feed" hidden></div>',
    '<div class="gev-ai-agent-actions" hidden></div>',
  ].join('');
  (host || document.body).appendChild(root);

  const toggle = root.querySelector('.gev-ai-agent-toggle');
  const rate = root.querySelector('.gev-ai-agent-rate');
  const bubble = root.querySelector('.gev-ai-agent-bubble');
  const feed = root.querySelector('.gev-ai-agent-feed');
  const actions = root.querySelector('.gev-ai-agent-actions');
  let expanded = false;
  let destroyed = false;

  function syncExpanded() {
    bubble.hidden = !expanded || !bubble.textContent;
    feed.hidden = !expanded;
    actions.hidden = !expanded || !actions.childElementCount;
    toggle.setAttribute('aria-expanded', String(expanded));
    root.classList.toggle('expanded', expanded);
  }

  toggle.addEventListener('click', () => {
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

    /** Severity word drives the glow; 'idle' turns the figure translucent. */
    setState(severity) {
      if (destroyed) return;
      const state = STATE_CLASS[severity] || 'idle';
      root.dataset.state = state;
      toggle.title =
        severity === 'idle'
          ? t('Sentinel: standby')
          : t('Sentinel: {state}', {
              state: severityWord[severity] || severityWord.info,
            });
      rate.hidden = severity === 'idle';
    },

    /** Announce nothing, just pool the event and refresh the surfaces. */
    pushEvent(event) {
      if (destroyed || !event) return;
      const severity = eventSeverity(event);
      const item = document.createElement('div');
      item.className = `gev-ai-agent-row sev-${severity}`;
      const when = event.at
        ? formatRelativeTime(-(Date.now() - event.at) / 1000, 'second')
        : '';
      const title = [
        event.kind === 'event-strong' ? '⚠' : '',
        event.label || event.layerId || '',
        event.detail || '',
      ]
        .filter(Boolean)
        .join(' — ');
      item.textContent = title;
      item.title = t('{title} · {when}', { title, when });
      feed.prepend(item);
      while (feed.childElementCount > FEED_LIMIT) feed.lastElementChild.remove();
      bubble.textContent = title;
      bubble.hidden = !expanded;
    },

    /** Actions the model planned: one row chip each, newest last. */
    showActions(rows) {
      if (destroyed) return;
      actions.textContent = '';
      for (const row of rows || []) {
        const chip = document.createElement('span');
        chip.className = 'gev-ai-agent-chip';
        chip.textContent = row;
        actions.appendChild(chip);
      }
      syncExpanded();
    },

    clearFreeze() {
      if (destroyed) return;
      bubble.hidden = !expanded || !bubble.textContent;
    },

    /** Dormant layer: keep the orb but grey it out and close the feed. */
    setSleeping(asleep) {
      if (destroyed) return;
      root.classList.toggle('asleep', Boolean(asleep));
      if (asleep) expanded = false;
      syncExpanded();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      root.remove();
    },
  };
}
