// Density mode: a 5 s refresh of the 250 nm patch around the view centre.
//
// The layer's ordinary poll is one worldwide snapshot every 30 s, rendered one
// poll interval behind (RENDER_DELAY_SEC). That cadence is what makes motion
// read as a slideshow next to a 1 Hz tracker, so this mode adds a second,
// cheaper read of just the patch the viewer is looking at, and shortens the
// display delay to match it. It is a MODE because it spends a volunteer
// network's rate limit: it polls only while an operator turns it on.
//
// Three bounds keep it polite, and all three are deliberate:
//   - DENSITY_POLL_MS (5 s) is the cadence a viewer actually needs to see
//     aircraft move smoothly at a regional zoom.
//   - DENSITY_MIN_GAP_MS (1 s) is a hard floor between attempts, so a camera
//     jump or a rapid toggle cannot produce a burst. The server enforces the
//     same 1 req/s across every viewer; this is the client-side half of it.
//   - A doubling backoff (5 s … 60 s) after failures, and a stand-down once
//     DENSITY_FAILURE_LIMIT consecutive patches fail. The ordinary 30 s poll
//     keeps running throughout, which is the fallback: a broken density feed
//     degrades to the layer as it was, never to an empty map.
//
// Failures are also kept OUT of the layer's own error state: the ordinary poll
// owns the layer's health, and a failing patch must not relabel a working
// worldwide feed as "live data unavailable".

/** Patches per mode session, in ms. */
export const DENSITY_POLL_MS = 5_000;

/** Hard floor between two attempts (the client half of the server's budget). */
export const DENSITY_MIN_GAP_MS = 1_000;

/** First backoff step; doubles per consecutive failure up to the cap. */
export const DENSITY_BACKOFF_BASE_MS = 5_000;

/** Backoff/retry ceiling, so a recovered feed is picked back up within a minute. */
export const DENSITY_BACKOFF_MAX_MS = 60_000;

/** Consecutive failed patches after which the mode stands down (and retries slowly). */
export const DENSITY_FAILURE_LIMIT = 3;

/** Display latency while density mode is on: one patch interval, not one poll. */
export const DENSITY_RENDER_DELAY_SEC = DENSITY_POLL_MS / 1000;

/**
 * Own the density timer, its budget and its backoff.
 *
 * @param {object} options
 * @param {object} options.feed The layer's feed record (read for its own state).
 * @param {(viewer: object, options: {signal: AbortSignal, dense: boolean}) => Promise<boolean>} options.refresh
 *   Ingestion's update; resolves true when a snapshot was applied.
 * @param {() => object|null} options.getViewer The live Cesium viewer.
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @param {(fn: Function, ms: number) => unknown} [options.setTimeoutImpl]
 * @param {(handle: unknown) => void} [options.clearTimeoutImpl]
 * @returns {object} Density session: start, stop, getStatus, destroy.
 */
export function createDensity({
  feed,
  refresh,
  getViewer,
  now = Date.now,
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutImpl = (handle) => clearTimeout(handle),
} = {}) {
  let enabled = false;
  let timer = null;
  let controller = null;
  let generation = 0;
  let failures = 0;
  let delayMs = DENSITY_POLL_MS;
  let lastAttemptAt = 0;
  let lastAppliedAt = null;
  let applied = 0;
  let inFlight = false;

  function clearTimer() {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
  }

  function schedule(ms) {
    clearTimer();
    delayMs = ms;
    const current = generation;
    timer = setTimeoutImpl(() => void tick(current), ms);
  }

  function backoffMs() {
    return Math.min(
      DENSITY_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
      DENSITY_BACKOFF_MAX_MS,
    );
  }

  async function tick(current) {
    timer = null;
    if (!enabled || current !== generation) return;
    // Budget floor: wait out whatever is left of the last second rather than
    // spending it, so a toggle or a camera jump cannot burst upstream.
    const sinceLast = now() - lastAttemptAt;
    if (lastAttemptAt && sinceLast < DENSITY_MIN_GAP_MS) {
      schedule(DENSITY_MIN_GAP_MS - sinceLast);
      return;
    }
    lastAttemptAt = now();
    controller = new AbortController();
    let accepted = false;
    inFlight = true;
    try {
      accepted =
        (await refresh(getViewer(), {
          signal: controller.signal,
          dense: true,
        })) === true;
    } catch {
      // An abort is this session being stopped, not a feed failure.
      if (!enabled || current !== generation) return;
      accepted = false;
    } finally {
      controller = null;
      inFlight = false;
    }
    if (!enabled || current !== generation) return;
    if (accepted) {
      failures = 0;
      applied += 1;
      lastAppliedAt = now();
      schedule(DENSITY_POLL_MS);
      return;
    }
    failures += 1;
    // Past the limit the mode stands down to a slow retry: the ordinary poll
    // carries the layer meanwhile, and a recovered feed rejoins within a minute.
    schedule(
      failures >= DENSITY_FAILURE_LIMIT ? DENSITY_BACKOFF_MAX_MS : backoffMs(),
    );
  }

  return {
    /** Turn the mode on (idempotent) and start polling. */
    start() {
      enabled = true;
      if (feed) feed._densityLive = true;
      if (timer !== null) return;
      generation += 1;
      schedule(DENSITY_POLL_MS);
    },

    /** Turn the mode off: the ordinary poll owns the layer again. */
    stop() {
      enabled = false;
      generation += 1;
      clearTimer();
      controller?.abort();
      controller = null;
      if (feed) feed._densityLive = false;
    },

    /**
     * The view moved: fetch the new centre's patch instead of waiting out the
     * rest of the current interval.
     *
     * Bounded by the same 1 s floor as everything else, so a camera being
     * dragged does not turn into a request per frame — at most one read per
     * second reaches the network however often this is called, which is the
     * budget the upstream is owed.
     */
    nudge() {
      if (!enabled || inFlight) return;
      const wait = Math.max(0, DENSITY_MIN_GAP_MS - (now() - lastAttemptAt));
      schedule(wait);
    },

    getStatus() {
      return {
        enabled,
        polling: timer !== null,
        failures,
        applied,
        delayMs,
        lastAppliedAt,
        degraded: failures >= DENSITY_FAILURE_LIMIT,
      };
    },

    destroy() {
      this.stop();
    },
  };
}
