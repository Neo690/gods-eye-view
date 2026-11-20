import { initFirstRunExperience } from '../firstRunExperience.js';
import { withinBudget } from './startupGuard.js';

/**
 * How long the loading cover waits for the style restoration.
 *
 * This wait begins after the application has published `ready`, so the startup
 * guard in startupGuard.js has already stood down: nothing else bounds it. A
 * share link or a style provider that never answers would otherwise leave the
 * cover up in front of a console that is fully built. Restoration reads local
 * storage first, so anything past this budget is a stall, not slow work.
 */
export const RESTORE_BUDGET_MS = 10000;

/** Reveal welcome controls only after restoration and the loading transition. */
export function startApplicationChrome({
  loadingScreen,
  styleManager,
  dataManager,
  signal,
  initializeWelcome = initFirstRunExperience,
  initializeSettings,
}) {
  let disposed = false;
  let firstRun;
  let revealTimer;
  let resolveDelay;
  const minimumDelay = new Promise((resolve) => {
    resolveDelay = resolve;
  });
  const delayTimer = setTimeout(resolveDelay, 1000);
  const revealFirstRun = () => {
    if (disposed || signal.aborted || firstRun) return;
    firstRun = initializeWelcome?.({ styleManager, dataManager });
    clearTimeout(revealTimer);
    loadingScreen.removeEventListener('transitionend', revealFirstRun);
  };
  // The deadline belongs to this screen, not to the session: teardown aborts it
  // so a stall that outlives the chrome leaves no timer and warns about nothing.
  const restorationDeadline = new AbortController();
  const restoration = withinBudget(
    styleManager.initialRestorePromise,
    RESTORE_BUDGET_MS,
    {
      signal: restorationDeadline.signal,
      onTimeout: () => {
        console.warn(
          `[Startup] style restoration still pending after ${RESTORE_BUDGET_MS} ms`,
        );
      },
    },
  );
  void Promise.all([restoration, minimumDelay])
    .catch(() => {
      /* Restoration reports its own outcome through the controls. */
    })
    .then(() => {
      if (disposed || signal.aborted) return;
      loadingScreen.classList.add('hidden');
      loadingScreen.addEventListener('transitionend', revealFirstRun, {
        once: true,
      });
      revealTimer = setTimeout(revealFirstRun, 900);
    });
  const keySetup = Promise.resolve(
    signal.aborted ? null : initializeSettings?.({ signal }),
  );
  // Own the pending initializer too; it must not reveal a dialog after abort.
  void keySetup.catch(() =>
    console.error('Provider settings initialization failed'),
  );
  return async () => {
    disposed = true;
    restorationDeadline.abort();
    clearTimeout(delayTimer);
    clearTimeout(revealTimer);
    resolveDelay();
    loadingScreen.removeEventListener('transitionend', revealFirstRun);
    firstRun?.destroy();
    (await keySetup.catch(() => null))?.destroy();
  };
}
