import { t } from '../i18n/index.js';

/**
 * How long one network-shaped startup step may wait before its degraded path is
 * taken. Photoreal tiles arrive from Google and the imagery stack from Esri;
 * neither answers at all on a network that blocks them.
 */
export const TILESET_BUDGET_MS = 12000;
export const STACK_BUDGET_MS = 15000;

/**
 * How long the whole startup may hold the loading cover before the operator is
 * let through. A software WebGL renderer draws the first frames slowly, but a
 * bound is what separates slow from stuck.
 */
export const STARTUP_BUDGET_MS = 30000;

/** What a budget returns when the work did not answer in time. */
export const TIMED_OUT = Symbol('startup-budget-expired');

/** What a budget settles with when its owner stopped waiting. */
const ABANDONED = Symbol('startup-budget-abandoned');

/**
 * Wait for `work`, but not forever.
 *
 * On timeout the caller's degraded answer is returned instead, so a step with
 * a fallback takes it rather than hanging the startup behind it. A result that
 * arrives after the budget has no owner any more: `onLate` receives it (a
 * tileset it can destroy instead of leaking), and a late failure is dropped
 * rather than surfacing as an unhandled rejection.
 *
 * An aborted `signal` settles the wait with nothing and skips `onTimeout`: the
 * owner has gone away, so its deadline must not outlive it, and a torn-down
 * screen should leave behind no timer and no warning about a stall nobody will
 * see. The work keeps its owner either way — `onLate` still receives a result
 * that lands afterwards, because no longer waiting for it does not dispose of
 * it — the tileset case this exists for is a tileset that must be destroyed.
 *
 * @template T
 * @param {Promise<T>|T} work
 * @param {number} ms
 * @param {{onTimeout?: () => any, onLate?: (value: T) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<T|any>}
 */
export async function withinBudget(
  work,
  ms,
  { onTimeout, onLate, signal } = {},
) {
  const pending = Promise.resolve(work);
  let timer;
  let onAbort;
  const waits = [
    pending,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms);
    }),
  ];
  if (signal) {
    waits.push(
      new Promise((resolve) => {
        onAbort = () => resolve(ABANDONED);
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
    );
  }
  let settled;
  try {
    settled = await Promise.race(waits);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  if (settled !== TIMED_OUT && settled !== ABANDONED) return settled;
  // Either way the caller has stopped waiting, so the result has no reader
  // left: `onLate` destroys it instead. Only a timeout takes a fallback.
  pending.then(
    (value) => onLate?.(value),
    () => {},
  );
  return settled === TIMED_OUT ? onTimeout?.() : undefined;
}

/**
 * Bound the startup as a whole.
 *
 * The cover is hidden by the last startup phase, so any earlier step that
 * never settles leaves it up for good: an operator staring at
 * "Initializing photorealistic world..." while the console behind it is fully
 * built and unreachable. After `budgetMs` the step the app stopped at is named
 * on the cover, and the cover is lifted, which is the fallback: a degraded but
 * usable console beats a frozen screen.
 *
 * This cannot speak for a page whose module graph never loads — no code runs
 * at all there — only for a stall after the application started.
 *
 * @param {object} options
 * @param {{getState: Function, subscribe: Function}} options.application
 * @param {{classList: {add: Function}, setAttribute?: Function}} [options.cover]
 * @param {{textContent: string, style?: object}} [options.status] The cover's
 *   status line, which already names the step in progress.
 * @param {number} [options.budgetMs]
 * @param {{set: Function, clear: Function}} [options.timers] Test seam.
 * @returns {() => void} Stop the guard.
 */
export function guardStartup({
  application,
  cover,
  status,
  budgetMs = STARTUP_BUDGET_MS,
  // Wrapped, not passed by reference: a browser's setTimeout throws
  // "Illegal invocation" when it is called as a method of another object.
  timers = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle),
  },
}) {
  const running = () => {
    const { status: state } = application.getState();
    return state === 'created' || state === 'starting';
  };
  let timer = timers.set(() => {
    timer = null;
    if (!running()) return;
    const { phase } = application.getState();
    const stage = status?.textContent?.trim() ?? '';
    const seconds = Math.round(budgetMs / 1000);
    console.warn(
      `[Startup] still in ${phase ?? 'startup'} after ${budgetMs} ms`,
    );
    if (status) {
      if (status.style) status.style.color = '';
      status.textContent = t(
        'Startup is still at “{stage}” after {seconds} s. Reload to try again; the console stays usable.',
        { stage, seconds },
      );
    }
    // The cover is the only thing between the operator and the console.
    cover?.classList.add('hidden');
    cover?.setAttribute?.('aria-hidden', 'true');
  }, budgetMs);
  // A finished startup owns the cover again, and its own transition reveals it.
  const unsubscribe = application.subscribe((state) => {
    if (state.status !== 'created' && state.status !== 'starting') {
      timers.clear(timer);
      timer = null;
    }
  });
  return () => {
    timers.clear(timer);
    timer = null;
    unsubscribe();
  };
}
