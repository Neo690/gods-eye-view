import { createStandaloneApplication } from './standalone/application.js';
import { applyDegradedControls } from './app/degradedMode.js';
import { guardStartup } from './app/startupGuard.js';
import { describeError } from './standalone/errors.js';
import { installInAppApi } from './data/inAppApi.js';
import { t } from './i18n/index.js';
import { setSplitFlapText } from './splitFlap.js';

// The module graph is alive: the classic watchdog in index.html stands down.
document.documentElement.dataset.boot = 'started';

// Inside the Android shell the page answers the routes whose logic it already
// carries; outside it this is a no-op. Installed before anything can fetch.
installInAppApi();

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
  // `?qaStall=<phase>` parks one startup phase forever so the 30 s guard can be
  // driven in a browser (scripts/qa-device-sweep.mjs). Nothing in the UI sets
  // it, and without the parameter it is null.
  stallPhase: new URLSearchParams(location.search).get('qaStall'),
});

const loadingScreen = document.getElementById('loading-screen');
const loaderStatus = loadingScreen?.querySelector('.loader-status');

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  if (!loaderStatus) return;
  loaderStatus.textContent = t('Error: {message}', {
    message: describeError(error),
  });
  loaderStatus.style.color = '#ff4444';
});

// A startup that stalls must say where and let the operator in, rather than
// leaving the cover up over a console that is already built.
const globalLoadingStatus = document.getElementById('global-loading-status');
const globalLoadingLabel = document.getElementById('global-loading-label');
const globalLoadingDetail = document.getElementById('global-loading-detail');
const globalLoadingActions = document.getElementById('global-loading-actions');

// A stall notice is not a message to wait out: it stays until the operator
// acts, so it carries the two actions that end it.
document
  .getElementById('global-loading-reload')
  ?.addEventListener('click', () => globalThis.location?.reload());
document
  .getElementById('global-loading-dismiss')
  ?.addEventListener('click', () => {
    // The shell owns the banner once it exists; before it does, hiding the
    // elements is all there is to hide (see the fallback below).
    const shell = application.getComponents()?.controls?.styleManager;
    if (typeof shell?.clearGlobalStatusNotice === 'function') {
      shell.clearGlobalStatusNotice();
      return;
    }
    if (globalLoadingStatus) globalLoadingStatus.hidden = true;
    if (globalLoadingActions) globalLoadingActions.hidden = true;
  });

guardStartup({
  application,
  cover: loadingScreen,
  status: loaderStatus,
  // A stall is shown where every other status is: the banner. Once the shell is
  // up it owns that banner — it recomputes its text, visibility and `data-state`
  // on every tick — so the sentence goes through the shell's persistent notice,
  // which outranks the loading summary. A stall in a phase that never built the
  // shell falls back to the elements themselves, which nothing else drives yet.
  // `missing` is every phase the stall left unbuilt: their controls are in the
  // markup already, so they are turned off rather than left to answer nothing.
  notify: (message, { missing = [] } = {}) => {
    applyDegradedControls({ missing });
    const shell = application.getComponents()?.controls?.styleManager;
    if (typeof shell?.showGlobalStatusNotice === 'function') {
      shell.showGlobalStatusNotice(message, { actions: true });
      return;
    }
    if (!globalLoadingStatus || !globalLoadingLabel) return;
    setSplitFlapText(globalLoadingLabel, message, { immediate: true });
    if (globalLoadingDetail) globalLoadingDetail.textContent = '';
    globalLoadingStatus.hidden = false;
    if (globalLoadingActions) globalLoadingActions.hidden = false;
  },
});

export { application };
