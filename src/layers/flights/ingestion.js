import { ERROR_BACKOFF_INTERVAL } from './recordPolicy.js';

// Marks English the Layers panel translates when it shows the error. Kept
// local: this module stays free of browser globals (package boundaries).
const msg = (text) => text;

/** Own acquisition, cancellation, freshness and backoff independently of rendering. */
export function createIngestion({
  feed,
  getQuery,
  applySnapshot,
  setSourceLabel,
  applyPendingTrackingRestore,
}) {
  const methods = {
    /**
     * One acquisition pass. `dense` reads the viewport's 250 nm patch instead of
     * the worldwide snapshot (see density.js); the two share every step after
     * the fetch so records, retention and tracking behave identically.
     * @returns {Promise<boolean>} True when a snapshot was applied.
     */
    async update(viewer, { signal = null, dense = false } = {}) {
      const nowMs = Date.now();
      const trackingRefreshEpoch = ++feed._trackingRefreshEpoch;
      feed._lastTrackingRefreshOutcome = {
        epoch: trackingRefreshEpoch,
        status: 'source-unavailable',
        ids: new Set(),
        source: feed._lastSource,
        coverage: feed._lastCoverage,
      };
      // The backoff belongs to the worldwide poll's own upstream. A density
      // patch reads a different service, so it is not held back by it — which
      // is what keeps the layer populated while OpenSky is rate limited.
      if (!dense && feed._retryAt && nowMs < feed._retryAt) {
        feed._backoff = true;
        return false;
      }

      const resourceController = new AbortController();
      feed._activeUpdateControllers.add(resourceController);
      const updateSignal = signal
        ? AbortSignal.any([signal, resourceController.signal])
        : resourceController.signal;
      try {
        updateSignal.throwIfAborted();
        if (dense && typeof feed._source.getDenseSnapshot !== 'function') {
          // Same name the live-source contract uses, without importing it: the
          // layer stays independent of the source package it is handed.
          const unsupported = new Error('Density source unavailable');
          unsupported.name = 'LiveSourceError';
          throw unsupported;
        }
        const snapshot = dense
          ? await feed._source.getDenseSnapshot(getQuery(viewer), {
              signal: updateSignal,
            })
          : await feed._source.getSnapshot(getQuery(viewer), {
              signal: updateSignal,
            });
        updateSignal.throwIfAborted();
        feed._lastStatus = snapshot.status ?? 200;
        const sourceEpochMs = snapshot.observedAtMs;
        const sourceAgeMs = snapshot.ageMs;
        const sourceStale = snapshot.stale || snapshot.freshness === 'unknown';
        feed._backoff = sourceStale;
        feed._retryAt = 0;
        // i18n-ignore: English data; the panel shows it through FEED_ERROR_PATTERNS (ui/statusText.js)
        feed._lastError = sourceStale
          ? sourceAgeMs == null
            ? msg('Source snapshot time unavailable')
            : `Source snapshot ${Math.max(2, Math.round(sourceAgeMs / 60_000))} min old`
          : null;
        // While density mode is live it owns the row's provenance: the 30 s
        // worldwide snapshot still merges its records, but it must not relabel
        // the layer as "one poll behind the world" when what the viewer is
        // watching is a 5 s regional patch — nor push "last update" backwards
        // to the older worldwide epoch.
        if (dense || !feed._densityLive) {
          feed._lastSource = snapshot.source;
          feed._lastCoverage = snapshot.coverage;
          setSourceLabel(feed._lastSource);
          feed._lastUpdate = sourceEpochMs;
        }
        const accepted = applySnapshot(snapshot, viewer);
        feed._count = accepted.count;
        feed._lastTrackingRefreshOutcome = {
          epoch: trackingRefreshEpoch,
          status: 'accepted',
          ids: accepted.ids,
          source: feed._lastSource,
          coverage: feed._lastCoverage,
        };
        console.log(`[Data:Flights] Updated: ${feed._count} aircraft`);
        applyPendingTrackingRestore();
        return true;
      } catch (e) {
        if (updateSignal.aborted || e?.name === 'AbortError') {
          throw new DOMException('Flights update aborted', 'AbortError');
        }
        if (dense) {
          // A failed patch is not the layer failing: the ordinary poll still
          // owns the row's health, error text and backoff. density.js counts
          // these failures, exposes them in its status and backs off.
          console.warn('[Data:Flights] Density fetch error:', e);
          return false;
        }
        console.warn('[Data:Flights] Fetch error:', e);
        feed._backoff = true;
        feed._retryAt =
          Date.now() + (e?.retryAfterMs ?? ERROR_BACKOFF_INTERVAL);
        feed._lastStatus = e?.status ?? null;
        if (e?.source) {
          feed._lastSource = e.source;
          setSourceLabel(feed._lastSource);
        }
        feed._lastError =
          e?.name === 'LiveSourceError'
            ? e.message
            : msg('Live data unavailable');
      } finally {
        feed._activeUpdateControllers.delete(resourceController);
      }
    },
  };

  return { methods };
}

/** Construct a fresh source lifetime and its refresh status. */
export function createFlightFeed(source) {
  const feed = {};
  feed._source = source;
  feed._count = 0;
  feed._lastUpdate = null;
  feed._backoff = false;
  feed._retryAt = 0;
  feed._lastError = null;
  feed._activeUpdateControllers = new Set();
  feed._lastStatus = null;
  feed._lastSource = source?.label || 'Aircraft';
  feed._lastCoverage = 'worldwide upstream snapshot';
  feed._trackingRefreshEpoch = 0;
  feed._lastTrackingRefreshOutcome = {
    epoch: 0,
    status: 'unavailable',
    ids: new Set(),
    source: feed._lastSource,
    coverage: null,
  };
  return feed;
}
