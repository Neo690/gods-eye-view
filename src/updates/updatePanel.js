/**
 * The console's UPDATE panel.
 *
 * A chrome-top button (`#update-check-btn`, scene-chrome.html) opens one small
 * panel that runs `checkForUpdate` and lists the three published channels:
 * each line names the platform, its rolling release's publish time and the
 * action that takes it — opening the artefact on the channel the console is
 * running from, or the release page for the others. The shell's own channel
 * is additionally answered by a dedicated hero button above the rows — the
 * one measure that matters on this machine: an amber "get the update" when a
 * newer build is published, a dimmed "open release" when the console is
 * current. Opening happens through
 * `openExternal`, supplied by the shell that owns this document: on desktop
 * Electron hands the popup to `shell.openExternal`, and iOS tabs out to
 * Safari.
 *
 * A shell that can install an update itself supplies `installUpdate` instead:
 * the Android shell downloads the APK in-app and opens PackageInstaller's own
 * confirmation, reporting progress through `watchUpdate`, so the same button
 * no longer sends the operator to a browser download. The open, install and
 * network behaviors are injected by the caller, so the panel wiring is
 * testable without a browser.
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

/**
 * One status line from the shell's installer, in the operator's language.
 * @param {{status?: string, progress?: number, message?: string}} event
 */
function describeUpdateEvent(event) {
  const status = String(event?.status || '');
  if (status === 'downloading') {
    const percent = Number(event.progress);
    return Number.isFinite(percent) && percent > 0
      ? `${t('Downloading the update')} ${Math.min(100, Math.round(percent))}%`
      : t('Downloading the update');
  }
  if (status === 'permission')
    return t('Allow installs from this app, then try again.');
  if (status === 'confirm')
    return t('Confirm the install in the system dialog.');
  if (status === 'restarting') return t('Restarting to apply the update\u2026');
  if (status === 'installed') return t('Installed. Reopen the app to use it.');
  if (status === 'failed')
    return t('The update could not be installed: {message}', {
      message: String(event.message || ''),
    });
  return '';
}

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

  // The shell's own channel is the one this document can install from inside
  // the app; the others can only be opened where their platform takes them.
  const installs =
    channel.id === platform &&
    channel.available &&
    typeof hooks.installUpdate === 'function';
  const action = doc.createElement('button');
  if (!channel.ok) {
    action.disabled = true;
    action.textContent = t(PAGE_LABEL);
    action.title = t('The channel has not been published yet.');
  } else {
    action.textContent = channel.available
      ? installs
        ? t('Download and install')
        : t('Get it')
      : t('Open release');
    action.title = String(channel.openUrl);
    action.addEventListener?.('click', () => {
      if (installs) hooks.installUpdate(channel);
      else hooks.openExternal(String(channel.openUrl));
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
 *   installUpdate?: (channel: object) => boolean|void,
 *   watchUpdate?: (listener: (event: object) => void) => () => void,
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
  // One installer channel for the life of the panel: events keep arriving
  // after the dialog is closed, and reopening must show the last one rather
  // than a blank line.
  let installLine = null;
  let installing = false;
  let lastUpdateEvent = null;
  const paintUpdate = (event) => {
    lastUpdateEvent = event || null;
    if (lastUpdateEvent?.status === 'failed') installing = false;
    if (installLine)
      installLine.textContent = describeUpdateEvent(lastUpdateEvent);
  };
  // A shell with no installer simply never calls back; the panel then offers
  // the external download it always did.
  const stopWatching =
    typeof hooks.watchUpdate === 'function'
      ? hooks.watchUpdate(paintUpdate)
      : () => {};
  const beginInstall = (channel) => {
    if (installing) return;
    installing = true;
    if (hooks.installUpdate(channel) === false) installing = false;
  };

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

      // The shell's own channel is the one this console can actually take, so
      // it gets a dedicated, emphasized button above the per-channel rows:
      // amber when an update is waiting, dimmed when the console is current,
      // and absent when the channel has not been published at all.
      const platform = shellPlatform();
      const own = info.channels.find((c) => c.id === platform);
      installLine = null;
      if (own?.ok) {
        const installable =
          own.available && typeof hooks.installUpdate === 'function';
        const hero = doc.createElement('div');
        hero.className = 'app-update-hero';
        const state = doc.createElement('span');
        state.textContent = own.available
          ? t('update available')
          : t(CURRENT_LABEL);
        state.className = 'app-update-hero-state';
        hero.appendChild(state);

        const heroAction = doc.createElement('button');
        heroAction.className = 'app-update-hero-action';
        if (own.available) heroAction.classList?.add('app-update-hero-open');
        heroAction.textContent = own.available
          ? installable
            ? t('Download and install')
            : t('Get the {platform} update', { platform: t(own.label) })
          : t('Open release');
        heroAction.title = String(own.openUrl);
        heroAction.addEventListener?.('click', () => {
          if (!installable) {
            hooks.openExternal(String(own.openUrl));
            return;
          }
          beginInstall(own);
        });
        hero.appendChild(heroAction);
        panel.appendChild(hero);
        if (installable) {
          installLine = doc.createElement('p');
          installLine.className = 'app-update-install-status';
          installLine.textContent = describeUpdateEvent(lastUpdateEvent);
          panel.appendChild(installLine);
        }
      }

      const list = doc.createElement('div');
      list.className = 'app-update-rows';
      // The row action shares the hero's one-at-a-time guard, and a shell with
      // no installer keeps the plain external link.
      const rowHooks =
        typeof hooks.installUpdate === 'function'
          ? { ...hooks, installUpdate: beginInstall }
          : hooks;
      for (const channel of info.channels) {
        list.appendChild(channelRow(doc, channel, platform, rowHooks));
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
    if (panel.contains(target) || target === btn || btn.contains?.(target))
      return;
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
      stopWatching();
      panel?.remove();
      panel = null;
    },
  };
}
