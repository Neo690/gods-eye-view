/**
 * The console's UPDATE panel.
 *
 * A chrome-top button (`#update-check-btn`, scene-chrome.html) opens one small
 * panel that runs `checkForUpdate` and lists the three published channels:
 * each line names the platform, its rolling release's publish time and the
 * action that takes it — opening the artefact on the channel the console is
 * running from, or the release page for the others. Opening happens through
 * `openExternal`, supplied by the shell that owns this document: on Android a
 * tap lands on the download via `ACTION_VIEW` (MainActivity already routes
 * non-asset popups to the system), on desktop Electron hands the popup to
 * `shell.openExternal`, and iOS tabs out to Safari.
 *
 * The open and network behaviors are injected by the caller, so the panel
 * wiring is testable without a browser.
 * @module updates/updatePanel
 */
import {
  checkForUpdate as defaultCheck,
  currentBundleStamps,
  shellPlatform,
} from './updateChannel.js';
import { t } from '../i18n/index.js';
import { msg } from '../i18n/marker.js';

// Short single words are kept in msg() data and joined through a variable on
// render: the icon-subset scanner reads any short literal in a direct
// textContent assignment as a Material glyph name, so keep them out of the
// assignment (docs/I18N.md, FEED_STATE_LABELS pattern).
const CURRENT_LABEL = msg('current');
const PAGE_LABEL = msg('page');

const PANEL_ID = 'app-update-panel';

function timestampLabel(iso) {
  if (!iso) return 'unpublished';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unpublished';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/**
 * Paint one channel line. Returns the row element.
 * @param {Document} doc
 * @param {object} channel one resolved channel of resolveUpdateInfo
 * @param {string} platform shellPlatform() result — this row gets emphasis
 * @param {{ openExternal: (url: string) => void }} hooks
 */
function channelRow(doc, channel, platform, hooks) {
  const row = doc.createElement('div');
  row.className = 'app-update-row';
  if (channel.id === platform) row.classList?.add('app-update-row-current');

  const label = doc.createElement('span');
  label.textContent = t(channel.label);

  const state = doc.createElement('span');
  if (!channel.ok) {
    state.textContent = t('channel not published');
  } else if (channel.available) {
    state.textContent = t('update available');
  } else {
    state.textContent = t(CURRENT_LABEL);
  }

  const at = doc.createElement('span');
  at.textContent = channel.ok ? timestampLabel(channel.publishedAt) : '';

  const action = doc.createElement('button');
  if (!channel.ok) {
    action.disabled = true;
    action.textContent = t(PAGE_LABEL);
    action.title = t('The channel has not been published yet.');
  } else {
    action.textContent = channel.available ? t('Get it') : t('Open release');
    action.title = String(channel.openUrl);
    action.addEventListener?.('click', () => {
      hooks.openExternal(String(channel.openUrl));
    });
  }

  row.appendChild(label);
  row.appendChild(state);
  row.appendChild(at);
  row.appendChild(action);
  if (channel.ok && channel.artefactName) {
    const artefact = doc.createElement('span');
    artefact.textContent = channel.artefactName;
    row.appendChild(artefact);
  }
  return row;
}

/**
 * Install the panel: click binding on the chrome button, an idempotent panel
 * body appended to the document, Escape and outside-click both close it.
 * @param {{ document?: Document }} services
 * @param {{
 *   openExternal: (url: string) => void,
 *   checkForUpdate?: () => Promise<object>,
 * }} hooks
 * @returns {{ destroy: () => void }}
 */
export function installUpdatePanel(services = {}, hooks) {
  const doc = services.document || document;
  if (!hooks?.openExternal) throw new Error('update panel needs openExternal');
  const checkForUpdate = hooks.checkForUpdate || defaultCheck;
  const btn = doc.getElementById('update-check-btn');
  if (!btn) return { destroy: () => {} };

  let open = false;
  let panel = doc.getElementById(PANEL_ID);

  const toggle = async () => {
    if (open) {
      open = false;
      panel?.setAttribute('hidden', '');
      return;
    }
    open = true;
    if (!panel) {
      panel = doc.createElement('div');
      panel.id = PANEL_ID;
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', t('App updates'));
      doc.body?.appendChild(panel);
    }
    panel.removeAttribute('hidden');
    panel.textContent = '';
    try {
      const title = doc.createElement('h2');
      title.textContent = t('APP UPDATES');
      panel.appendChild(title);

      const buildLine = doc.createElement('p');
      const stamps = currentBundleStamps();
      buildLine.textContent =
        t('This build:') +
        ' ' +
        (stamps.buildSha || '\u2014') +
        ' \u00b7 ' +
        timestampLabel(stamps.buildTime);
      panel.appendChild(buildLine);

      const status = doc.createElement('p');
      status.textContent = t('Checking the channels\u2026');
      panel.appendChild(status);

      const info = await checkForUpdate();
      // The panel may have closed while the network answered; an answer that
      // lands on a hidden panel must not repaint it.
      if (panel.getAttribute('hidden') !== null) return;
      status.textContent = info.channels.some((c) => c.ok)
        ? t('Releases from Neo690/gods-eye-view:')
        : t('The release list could not be read (network or rate limit).');

      const list = doc.createElement('div');
      list.className = 'app-update-rows';
      const platform = shellPlatform();
      for (const channel of info.channels) {
        list.appendChild(channelRow(doc, channel, platform, hooks));
      }
      panel.appendChild(list);
    } catch (error) {
      // A broken check must still leave the panel honest about why it is
      // empty, not silently blank.
      const status = panel.lastChild;
      if (status) {
        status.textContent =
          t('The release list could not be read (network or rate limit).') +
          ' ' +
          String(error && error.message ? error.message : error);
      }
    }
  };

  const onKey = (event) => {
    if (event.key === 'Escape' && open) toggle();
  };
  const onClickOutside = (event) => {
    if (!open || !panel) return;
    const target = event.target;
    if (panel.contains(target) || target === btn || btn.contains?.(target)) return;
    open = false;
    panel.setAttribute('hidden', '');
  };

  const buttonListener = () => toggle();
  btn.addEventListener('click', buttonListener);
  doc.addEventListener?.('keydown', onKey);
  doc.addEventListener?.('click', onClickOutside, true);

  return {
    destroy() {
      btn.removeEventListener('click', buttonListener);
      doc.removeEventListener?.('keydown', onKey);
      doc.removeEventListener?.('click', onClickOutside, true);
      panel?.remove();
      panel = null;
    },
  };
}
