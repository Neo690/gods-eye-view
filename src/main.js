import { createStandaloneApplication } from './standalone/application.js';
import { guardStartup } from './app/startupGuard.js';
import { describeError } from './standalone/errors.js';
import { installInAppApi } from './data/inAppApi.js';
import { t } from './i18n/index.js';

// Inside the Android shell the page answers the routes whose logic it already
// carries; outside it this is a no-op. Installed before anything can fetch.
installInAppApi();

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
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
guardStartup({ application, cover: loadingScreen, status: loaderStatus });

export { application };
