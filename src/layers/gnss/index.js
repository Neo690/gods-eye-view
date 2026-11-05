import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  GNSS_LEVEL_COLORS,
  GNSS_MIN_AIRCRAFT,
  GNSS_WINDOW_MS,
  accumulateGnssObservations,
  binGnssCells,
  gnssProvenance,
  pruneGnssObservations,
} from './records.js';
export * from './records.js';
export { createAdsbGnssSource } from './source.js';

/**
 * GroundPrimitive allowPicking:false suppresses ids but still submits stencil
 * commands in Cesium's pick pass, erasing picks of overlapping ground geometry.
 * This fill participates only in rendering, so sibling polygons remain pickable.
 */
class GnssGroundFill extends Cesium.GroundPrimitive {
  update(frameState) {
    if (!frameState.passes.pick) super.update(frameState);
  }
}

/** Low stays visible over land so coverage reads apart from no data. */
const FILL_ALPHA = Object.freeze({ low: 0.3, medium: 0.42, high: 0.55 });
const LEVEL_LABELS = Object.freeze({
  low: msg('Low-accuracy score < 2%'),
  medium: msg('Low-accuracy score 2–10%'),
  high: msg('Low-accuracy score > 10%'),
});

/** Degrees at the centre of the current view, or null before the camera settles. */
export function defaultGnssViewAnchor(viewer) {
  const canvas = viewer?.scene?.canvas;
  const ellipsoid = viewer?.scene?.globe?.ellipsoid;
  // At globe scale the visible rectangle can be the whole world, whose
  // midpoint is unrelated to the place under the screen centre.
  const centre =
    canvas?.clientWidth > 0 &&
    canvas.clientHeight > 0 &&
    viewer.camera?.pickEllipsoid?.(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      ellipsoid,
    );
  const rectangle =
    !centre && viewer?.camera?.computeViewRectangle?.(ellipsoid);
  const carto = centre
    ? (ellipsoid || Cesium.Ellipsoid.WGS84).cartesianToCartographic(centre)
    : rectangle
      ? Cesium.Rectangle.center(rectangle)
      : viewer?.camera?.positionCartographic;
  if (!carto) return null;
  const latitude = Cesium.Math.toDegrees(carto.latitude);
  const longitude = Cesium.Math.toDegrees(carto.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    ? { latitude, longitude }
    : null;
}

/** User-initiated coverage sweep. The ordinary route samples only the view
 * anchor; a sweep extends observed coverage to a coarse whole-degree lattice
 * around it, once, on explicit request. 250 nm (~4.2°) circles on a 5° lattice
 * just overlap, so no point of the swept plane is farther from an anchor than
 * one cell radius. */
export const GNSS_SWEEP_SPACING_DEG = 5;
/** Half-width of the lattice in degrees; the budget usually stops long before
 * the corner, which the distance ordering guarantees is reached last. */
export const GNSS_SWEEP_MAX_DEG = 20;
/** Per-sweep request budget: at the 3 s pace a full sweep spends under half
 * of the server's per-minute view cap and under half of its per-hour sweep
 * budget, so an honest operator never feels the server's refusal lane. */
export const GNSS_SWEEP_MAX_QUERIES = 24;
/** Wall-clock pace between sweep reads; keeps the whole sweep well inside the
 * server's per-minute view limiter rather than testing its edges. */
export const GNSS_SWEEP_STAGGER_MS = 3000;

/** Nearest-first whole-degree lattice around a view anchor, view anchor
 * excluded (the ordinary route owns it), deduplicated across the antimeridian,
 * out of polar latitudes. Pure geometry: the caller applies recency and the
 * per-sweep budget.
 *
 * @param {{latitude: number, longitude: number}} view The camera anchor.
 * @returns {Array<{latitude: number, longitude: number}>} Ordered lattice anchors.
 */
export function gnssSweepPlan({ latitude, longitude } = {}) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
  const lat0 = Math.round(latitude);
  const lon0 = Math.round(longitude);
  const kept = new Map();
  for (
    let dLat = -GNSS_SWEEP_MAX_DEG;
    dLat <= GNSS_SWEEP_MAX_DEG;
    dLat += GNSS_SWEEP_SPACING_DEG
  ) {
    for (
      let dLon = -GNSS_SWEEP_MAX_DEG;
      dLon <= GNSS_SWEEP_MAX_DEG;
      dLon += GNSS_SWEEP_SPACING_DEG
    ) {
      // dLat = dLon = 0 is the view anchor the ordinary route already reads.
      if (dLat === 0 && dLon === 0) continue;
      const lat = Math.min(85, Math.max(-85, lat0 + dLat));
      const lon = Math.trunc(((((lon0 + dLon + 180) % 360) + 360) % 360) - 180);
      const key = `${lat},${lon}`;
      const distanceSq = dLat * dLat + dLon * dLon;
      const previous = kept.get(key);
      if (!previous || distanceSq < previous[0])
        kept.set(key, [distanceSq, { latitude: lat, longitude: lon }]);
    }
  }
  return [...kept.values()]
    .sort((a, b) => a[0] - b[0] || a[1].latitude - b[1].latitude)
    .map(([, anchor]) => anchor);
}

/**
 * Own one GNSS navigation-integrity display: rolling integrity observations
 * around the views the user visits, binned into cells coloured by the
 * gpsjam low-accuracy score. Share links retain token 3.
 */
export function createGnssIntegrityLayer({
  source,
  viewAnchor = defaultGnssViewAnchor,
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  windowMs = GNSS_WINDOW_MS,
  /** The wall pace between sweep reads; 0 is a test-only configuration. */
  sweepStaggerMs = GNSS_SWEEP_STAGGER_MS,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('GNSS integrity layer requires a snapshot source');
  let _viewer = null;
  let _primitives = null;
  let _request = null;
  let _enabled = false;
  let _cells = [];
  let _signature = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _manager = null;
  let _cameraTimer = null;
  let _backgroundRefresh = null;
  let _lastQueryKey = null;
  let _lastRequestAt = -Infinity;
  let _removeCameraEnd = null;
  let _removeCameraChanged = null;
  let _coverage = null;
  let _retryTimer = null;
  let _retryAt = 0;
  let _failureCount = 0;
  let _sweepController = null;
  let _lastSweepAt = null;
  let _lastSweepKey = null;
  const _recentQueries = new Map(); // whole-degree key -> monotonic time
  const _sweep = {
    running: false,
    done: 0,
    total: 0,
    failed: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
  const _observations = new Map();
  const provenance = gnssProvenance({
    windowMs,
    sweep: {
      id: 'user-grid-sweep',
      spacingDeg: GNSS_SWEEP_SPACING_DEG,
      reachDeg: GNSS_SWEEP_MAX_DEG,
      maxQueries: GNSS_SWEEP_MAX_QUERIES,
      staggerMs: sweepStaggerMs,
      serverSideRefusal:
        'per-client hourly sweep budget (GNSS_SWEEP_MAX_PER_HOUR) and kill switch (GNSS_SWEEP_ENABLED=0 answers HTTP 403)',
      definedBy: 'GEV',
      validated: false,
    },
  });

  const queryKey = (anchor) =>
    anchor
      ? `${Math.round(anchor.latitude)},${Math.round(anchor.longitude)}`
      : null;

  function scheduleCameraRefresh() {
    if (!_enabled || !_primitives) return;
    if (now() < _retryAt) return;
    const key = queryKey(viewAnchor(_viewer));
    if (!key || key === _lastQueryKey) return;
    clearTimeout(_cameraTimer);
    // Debounce drags and bound moving/follow cameras to at most 24 requests
    // per minute. Nearby views share the proxy's whole-degree cache key.
    _cameraTimer = setTimeout(
      async () => {
        _cameraTimer = null;
        if (!_enabled || _backgroundRefresh || _request) return;
        const key = queryKey(viewAnchor(_viewer));
        if (!key || key === _lastQueryKey) return;
        await refreshInBackground();
      },
      Math.max(600, 2500 - (monotonicNow() - _lastRequestAt)),
    );
  }

  async function refreshInBackground() {
    if (!_enabled || _backgroundRefresh) return;
    const controller = new AbortController();
    _backgroundRefresh = controller;
    try {
      if (_manager)
        await _manager.refreshLayer(layer.id, { signal: controller.signal });
      else await layer.update(undefined, { signal: controller.signal });
    } finally {
      if (_backgroundRefresh === controller) {
        _backgroundRefresh = null;
        scheduleCameraRefresh();
        scheduleRetry();
      }
    }
  }

  function scheduleRetry() {
    clearTimeout(_retryTimer);
    _retryTimer = null;
    if (!_enabled || !_retryAt) return;
    // Long provider cooldowns keep their full deadline. Browser timers cannot
    // exceed ~24 days, so wake in bounded chunks without fetching early.
    _retryTimer = setTimeout(
      () => {
        _retryTimer = null;
        void refreshInBackground();
      },
      Math.min(2147483647, Math.max(0, _retryAt - now())),
    );
    _retryTimer?.unref?.();
  }

  /** Record that a whole-degree anchor was just read, so a sweep a minute
   * later does not spend its budget re-fetching coverage the store holds. */
  function noteQuery(key) {
    if (!key) return;
    _recentQueries.set(key, monotonicNow());
    for (const [k, at] of _recentQueries) {
      const age = monotonicNow() - at;
      if (age < 0 || age > windowMs) _recentQueries.delete(k);
    }
  }

  /** Abort-aware wait that resolves (never rejects); the sweep loop re-checks
   * its own stop conditions instead of racing this helper. */
  function delay(ms, signal) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  function stopCoverageSweep() {
    _sweepController?.abort();
    _sweepController = null;
  }

  async function runSweep(plan, controller) {
    const { signal } = controller;
    for (const anchor of plan) {
      if (signal.aborted || !_enabled) break;
      try {
        const snapshot = await source.getSnapshot(anchor, { signal });
        if (signal.aborted || !_enabled) break;
        // Same evidence path as the ordinary update: the age the proxy reports
        // dates these rows, so a sweep never re-dates a cached replay as new.
        const at = now();
        accumulateGnssObservations(_observations, snapshot.rows, at, {
          windowMs,
          observedAt: at - snapshot.ageMs,
        });
        _cells = binGnssCells(_observations);
        render();
        noteQuery(queryKey(anchor));
        _sweep.done += 1;
      } catch (error) {
        if (signal.aborted || !_enabled) break;
        _sweep.failed += 1;
        console.warn('[Data:GNSS] sweep fetch error:', error);
        // A budget or cooldown refusal (429 with its Retry-After) ends the
        // sweep: the remaining anchors would each just spend guaranteed
        // refusals. A terminal refusal (the server's kill-switch 403) stops
        // it for the same reason.
        if (
          (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0) ||
          error?.retryable === false
        ) {
          _sweep.error =
            error?.message || msg('GNSS integrity source unavailable');
          break;
        }
      }
      if (signal.aborted) break;
      if (sweepStaggerMs > 0) await delay(sweepStaggerMs, signal);
    }
    if (_sweepController === controller) _sweepController = null;
    _sweep.running = false;
    _sweep.finishedAt = now();
  }

  /**
   * Optional user-initiated coverage sweep. Independent of the manager: it
   * fetches, accumulates and re-bins through the same evidence path as
   * `update`, without touching the feed's own error and retry lane.
   */
  function startCoverageSweep() {
    if (_sweep.running) return true; // the chip becomes the stop control
    if (!_enabled || !_primitives) return false;
    const view = viewAnchor(_viewer);
    if (!view) return false;
    // One sweep per view per window: a second press while the first sweep's
    // evidence is still live adds nothing worth the budget.
    const viewKey = queryKey(view);
    if (
      _lastSweepAt != null &&
      monotonicNow() - _lastSweepAt < windowMs &&
      _lastSweepKey === viewKey
    )
      return false;
    const plan = gnssSweepPlan(view)
      .filter(
        (anchor) =>
          monotonicNow() -
            (_recentQueries.get(queryKey(anchor)) ?? -Infinity) >=
          windowMs,
      )
      .slice(0, GNSS_SWEEP_MAX_QUERIES);
    if (!plan.length) return false;
    _sweep.running = true;
    _sweep.done = 0;
    _sweep.total = plan.length;
    _sweep.failed = 0;
    _sweep.error = null;
    _sweep.startedAt = now();
    _sweep.finishedAt = null;
    _lastSweepAt = monotonicNow();
    _lastSweepKey = viewKey;
    const controller = new AbortController();
    _sweepController = controller;
    void runSweep(plan, controller);
    return true;
  }

  /** Age the store without new evidence, so expired cells leave the globe. */
  function expire() {
    pruneGnssObservations(_observations, now(), { windowMs });
    _cells = binGnssCells(_observations);
    render();
  }

  function render() {
    // Only the id and band change what is drawn; counts alone do not.
    const signature = JSON.stringify(
      _cells.map(({ id, level }) => [id, level]),
    );
    if (signature === _signature) return;
    _signature = signature;
    _primitives.removeAll();
    if (_cells.length) {
      _primitives.add(
        new GnssGroundFill({
          geometryInstances: _cells.map(
            (cell) =>
              new Cesium.GeometryInstance({
                id: `${layer.id}:${cell.id}`,
                geometry: new Cesium.RectangleGeometry({
                  rectangle: Cesium.Rectangle.fromDegrees(
                    cell.west,
                    cell.south,
                    cell.east,
                    cell.north,
                  ),
                  vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                }),
                attributes: {
                  color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                    Cesium.Color.fromCssColorString(
                      GNSS_LEVEL_COLORS[cell.level],
                    ).withAlpha(FILL_ALPHA[cell.level]),
                  ),
                },
              }),
          ),
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: true,
          }),
          classificationType: Cesium.ClassificationType.BOTH,
          allowPicking: false,
          // Retain the compact rectangle descriptors for inspection, not Entity visualizers.
          releaseGeometryInstances: false,
        }),
      );
    }
    _viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: 'gnss-integrity',
    name: 'GNSS Integrity',
    icon: '📡',
    source: 'adsb.lol',
    /** Where each part of the method comes from; see records.js. */
    provenance,
    updateInterval: 60000,

    attachDataManager(manager) {
      _manager = manager;
    },

    init(viewer) {
      if (_viewer)
        throw new Error('GNSS integrity layer is already initialized');
      _viewer = viewer;
      _primitives = new Cesium.PrimitiveCollection();
      _primitives.id = layer.id;
      _primitives.show = false;
      viewer.scene.groundPrimitives.add(_primitives);
      _removeCameraEnd = viewer.camera?.moveEnd?.addEventListener(
        scheduleCameraRefresh,
      );
      _removeCameraChanged = viewer.camera?.changed?.addEventListener(
        scheduleCameraRefresh,
      );
    },

    enable() {
      _enabled = true;
      // Cells left from before a long disable must not reappear past the window.
      if (_primitives) {
        expire();
        _primitives.show = true;
      }
    },

    disable() {
      clearTimeout(_cameraTimer);
      _cameraTimer = null;
      clearTimeout(_retryTimer);
      _retryTimer = null;
      stopCoverageSweep();
      _backgroundRefresh?.abort();
      _backgroundRefresh = null;
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_primitives) _primitives.show = false;
    },

    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || !_primitives || signal?.aborted) return false;
      if (now() < _retryAt) {
        expire();
        scheduleRetry();
        return true;
      }
      _retryAt = 0;
      clearTimeout(_retryTimer);
      _retryTimer = null;
      const anchor = viewAnchor(_viewer);
      // No anchor yet (camera still settling) is not a failure: returning
      // false would make the manager reject the enable. The next interval
      // retries; cells already drawn still age out of the window.
      if (!anchor) {
        expire();
        return true;
      }
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const onAbort = () => request.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      _lastQueryKey = queryKey(anchor);
      _lastRequestAt = monotonicNow();
      noteQuery(_lastQueryKey);
      _coverage = {
        kind: 'regional',
        latitude: Math.round(anchor.latitude),
        longitude: Math.round(anchor.longitude),
        radiusNm: 250,
      };
      let received = false;
      try {
        const snapshot = await source.getSnapshot(anchor, {
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        received = true;
        // Date the rows by when the proxy observed them: a cached or stale
        // replay keeps its original age instead of restarting the window.
        // The proxy reports that age, so client and server clocks never mix.
        const at = now();
        accumulateGnssObservations(_observations, snapshot.rows, at, {
          windowMs,
          observedAt: at - snapshot.ageMs,
        });
        _cells = binGnssCells(_observations);
        render();
        _stale = snapshot.stale === true;
        _lastUpdate = at - snapshot.ageMs;
        _lastError = null;
        _retryAt = 0;
        _failureCount = 0;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        // A renderer/programming failure remains a real lifecycle failure.
        // Only acquisition failures are kept enabled for recovery.
        if (received) throw e;
        console.warn('[Data:GNSS] Fetch error:', e);
        _lastError = e?.message || msg('GNSS integrity source unavailable');
        // Keep the last cells only while their evidence is inside the window.
        expire();
        if (e?.retryable === false) return false;
        _failureCount = Math.min(3, _failureCount + 1);
        const delay =
          Number.isFinite(e?.retryAfterMs) && e.retryAfterMs > 0
            ? e.retryAfterMs
            : Math.min(120000, 30000 * 2 ** (_failureCount - 1));
        _retryAt = Math.max(
          _retryAt,
          Math.min(Number.MAX_VALUE, now() + delay),
        );
        // Enabling the display succeeded. Stats still report an unavailable
        // or degraded feed; the manager keeps its normal refresh failure lane.
        return true;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (_request === request) _request = null;
        scheduleCameraRefresh();
        scheduleRetry();
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _removeCameraEnd?.();
      _removeCameraChanged?.();
      _removeCameraEnd = null;
      _removeCameraChanged = null;
      _observations.clear();
      _cells = [];
      _signature = null;
      if (_primitives) {
        viewer.scene.groundPrimitives.remove(_primitives);
        _primitives = null;
      }
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
      _coverage = null;
      _retryAt = 0;
      _failureCount = 0;
      _lastQueryKey = null;
      _manager = null;
      stopCoverageSweep();
      _recentQueries.clear();
      _lastSweepAt = null;
      _lastSweepKey = null;
      _sweep.running = false;
      _sweep.done = 0;
      _sweep.total = 0;
      _sweep.failed = 0;
      _sweep.error = null;
      _sweep.startedAt = null;
      _sweep.finishedAt = null;
    },

    startCoverageSweep,

    getRowControls() {
      const sweepNote = _sweep.running
        ? t('Coverage sweep · {done} of {total} anchors', {
            done: formatNumber(_sweep.done),
            total: formatNumber(_sweep.total),
          })
        : _sweep.total && (_sweep.error || _sweep.failed)
          ? t('Last sweep: {done} of {total} anchors; {failed} failed', {
              done: formatNumber(_sweep.done),
              total: formatNumber(_sweep.total),
              failed: formatNumber(_sweep.failed),
            })
          : null;
      return {
        chips: [
          {
            id: 'sweep',
            label: _sweep.running ? t('Stop sweep') : t('Coverage sweep'),
            title: t(
              'Fetch up to {count} extra lattice anchors around the view once, at a deliberate pace. The server keeps its own per-hour budget and an overall kill switch.',
              { count: formatNumber(GNSS_SWEEP_MAX_QUERIES) },
            ),
            active: _sweep.running,
            busy: _sweep.running,
            onClick: () =>
              _sweep.running ? stopCoverageSweep() : startCoverageSweep(),
          },
        ],
        info:
          t(
            'Regional sample · 250 nm radius · cells from visited views over 30 min',
          ) +
          (_lastError && _retryAt
            ? ` · ${translateFeedError(_lastError)} · ${
                _retryAt <= 8640000000000000
                  ? t('Retrying automatically at {time} UTC', {
                      time: new Date(_retryAt).toISOString().slice(11, 19),
                    })
                  : t('Retrying automatically after provider cooldown')
              }`
            : '') +
          (sweepNote ? ` · ${sweepNote}` : ''),
        infoTitle: t(
          'Updates automatically after pan or zoom and once a minute. The public feed covers a 250-nautical-mile circle around the view centre; zooming out does not make it a worldwide snapshot. Blank cells are outside sampled coverage or have insufficient observations. The optional coverage sweep fetches up to {count} whole-degree lattice anchors around the view once, on request only; the server refuses sweeps past its own per-hour budget and disabling (GNSS_SWEEP_ENABLED=0).',
          { count: formatNumber(GNSS_SWEEP_MAX_QUERIES) },
        ),
        legend: ['high', 'medium', 'low'].map((level, index) => ({
          label: t(LEVEL_LABELS[level]),
          color: GNSS_LEVEL_COLORS[level],
          count: _cells.filter((cell) => cell.level === level).length,
          ...(index === 0
            ? {
                blurb: t(
                  'Low-accuracy score = 100 × max(0, bad − 1) / total: one aircraft is discounted, so this is not the raw share. Cells need {aircraft} aircraft over {minutes} minutes. Navigation-integrity anomalies are not a detection of jamming or spoofing, and only a high cell counts as evidence-grade for a cross-layer reading — transient low accuracy is a common coincidence in dense traffic.',
                  {
                    aircraft: formatNumber(GNSS_MIN_AIRCRAFT),
                    minutes: formatNumber(provenance.window.minutes),
                  },
                ),
              }
            : {}),
        })),
      };
    },

    getStats() {
      return {
        count: _cells.length,
        levels: Object.fromEntries(
          ['low', 'medium', 'high'].map((level) => [
            level,
            _cells.filter((cell) => cell.level === level).length,
          ]),
        ),
        lastUpdate: _lastUpdate,
        error: _lastError,
        retryInSec: _retryAt
          ? Math.max(0, Math.ceil((_retryAt - now()) / 1000))
          : null,
        stale: _stale,
        provenance,
        coverage: _coverage,
        sweep: {
          running: _sweep.running,
          done: _sweep.done,
          total: _sweep.total,
          failed: _sweep.failed,
          error: _sweep.error,
          startedAt: _sweep.startedAt,
          finishedAt: _sweep.finishedAt,
        },
        // Load-bearing: without an explicit boolean, layerFeedState reads the
        // adsb.lol source name as a flights fallback (src/data/feedState.js).
        fallback: false,
      };
    },
  };
  return layer;
}
