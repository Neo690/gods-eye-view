// The Sentinel data layer ("AI Agent" is the id it keeps, "Sentinel" what it
// shows): a small robot spider that walks the globe instead of an avatar that
// watches it from a corner.
//
//   - the watchdog (watch.js) still diffs the data-layer roster every cycle,
//     so a feed that breaks is news the operator reads,
//   - the spider (spider.js) walks the surface: it picks one inspection target
//     among the enabled layers (patrol.js ranks them by severity, feed health,
//     freshness, distance and how long ago it looked), crawls to the nearest
//     record of the chosen layer, scans it and reports what the layer holds,
//   - the patrol is local and deterministic. Nothing here changes the
//     operator's layers, and nothing moves the camera: the spider walks, the
//     view stays where the operator put it,
//   - a model is optional and only ever words a finding that matters
//     (brief.js), at most once every twenty minutes. With no key the layer is
//     exactly as useful, and spends nothing.
// The body is Cesium entities; the inspection note rides the world-overlay
// host (entity labels are forbidden); the report card is DOM (see overlay.js),
// so disabling the layer removes all three with no cleanup left behind.
import {
  t,
  tn,
  msg,
  formatNumber,
  translateKnown,
  getLocale,
} from '../../i18n/index.js';
import {
  watchLayers,
  worstSeverity,
  readStrongRecord,
  eventSeverity,
} from './watch.js';
import { createAvatarOverlay } from './overlay.js';
import {
  createSpiderBody,
  destroySpiderNoteOverlay,
  spiderSpriteFrames,
  SPIDER_SPRITE_FRAMES,
  syncSpiderNoteOverlay,
} from './spider.js';
import {
  angularDistance,
  rankInspectionTargets,
  stepPatrol,
  REST_MS,
  SCAN_MS,
  toDegrees,
} from './patrol.js';
import { requestFindingBrief, BRIEF_MIN_INTERVAL_MS } from './brief.js';

export const AI_AGENT_LAYER_ID = 'ai-agent';

/** Manager cadence: one roster diff per cycle. */
const WATCH_INTERVAL_MS = 30 * 1000;

/** Events older than this stop pulling the spider and ranking targets. */
const EVENT_MEMORY_MS = 10 * 60 * 1000;

/** Positions sampled from one layer when looking for its nearest record. */
const PULSE_SAMPLE = 512;

/** Arc walked per sprite frame: the gait follows distance, not wall time. */
const GAIT_RAD_PER_FRAME = 0.011;

/** Where the spider appears when the camera cannot say where it looks. */
const FALLBACK_SPAWN = Object.freeze({ latDeg: 20, lonDeg: 0 });

/** Longest stretch of time one frame may advance the walk. */
const MAX_FRAME_DT_S = 0.25;

/**
 * Wire the spider to what the application owns.
 *
 * @param {object} [options]
 * @param {{doc?: Document}} [options.docScope] test seam for the report card.
 * @param {() => number} [options.now] clock seam.
 * @param {Function} [options.fetchImpl] relay seam for the optional brief.
 * @returns {object} data-layer module (lifecycle contract).
 */
export function createAiAgentLayer({
  docScope = undefined,
  now: nowSource = Date.now,
  fetchImpl = undefined,
} = {}) {
  let document = docScope ?? globalThis.document;
  let manager = null;
  let viewer = null;
  let avatar = null;
  let body = null;
  let enabled = false;
  let destroyed = false;
  let stopAnimation = null;

  // Watchdog memory (watchLayers owns its shapes).
  const watchState = { previous: null, seen: new Set() };
  const recentEvents = [];
  const visitedAt = {};
  let lastSeen = null;

  // The spider's own state, read by the Cesium callbacks every frame.
  const spider = {
    latDeg: FALLBACK_SPAWN.latDeg,
    lonDeg: FALLBACK_SPAWN.lonDeg,
    headingRad: 0,
    frame: 0,
    visible: false,
    scanning: false,
    ringRadiusM: 400_000,
    note: '',
    severity: 'info',
  };
  let spriteFrames = [];
  let gaitRad = 0;
  let target = null;
  let phase = 'rest';
  let scanUntil = 0;
  let restUntil = 0;
  let lastFrameAt = 0;
  let lastBriefAt = 0;
  let briefing = false;

  const strId = (raw) => String(raw?.id ?? '');

  /**
   * The world-overlay entry that names what the spider is inspecting rides
   * wherever `spider.note` changes, so the caption can never stale behind the
   * walk. Entry graphics are forbidden for this (noCesiumLabels). A vanishing
   * note removes the entry rather than drawing an empty caption.
   */
  function syncNote() {
    if (destroyed) return;
    syncSpiderNoteOverlay({ state: spider });
  }

  /** Events about a layer still fresh enough to matter. */
  function freshEvents(withinMs = EVENT_MEMORY_MS) {
    const now = nowSource();
    return recentEvents.filter((event) => now - event.at < withinMs);
  }

  function latestEventFor(layerId) {
    for (let i = recentEvents.length - 1; i >= 0; i--) {
      if (recentEvents[i].layerId === layerId) return recentEvents[i];
    }
    return null;
  }

  /**
   * Where the spider would stand to inspect one layer: the nearest positioned
   * record it actually holds. A layer whose records carry no position (road
   * traffic, an unconfigured feed) has nowhere to walk to, so it is skipped
   * rather than inspected from a made-up spot.
   */
  function inspectionPoint(layerId) {
    const module = manager?.layers?.get?.(layerId)?.module;
    if (typeof module?.getAllPositions !== 'function') return null;
    let rows = [];
    try {
      rows = module.getAllPositions(PULSE_SAMPLE) || [];
    } catch {
      return null; // a throwing reader is the same as no reader
    }
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rows.length; i++) {
      const latDeg = Number(rows[i]?.latitude);
      const lonDeg = Number(rows[i]?.longitude);
      if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) continue;
      const distance = angularDistance(spider, { latDeg, lonDeg });
      if (!Number.isFinite(distance) || distance >= bestDistance) continue;
      bestDistance = distance;
      best = { latDeg, lonDeg };
    }
    return best;
  }

  /** Every enabled layer the spider could walk to, with what it knows of it. */
  function inspectionCandidates() {
    if (!manager || typeof manager.getAll !== 'function') return [];
    const out = [];
    for (const raw of manager.getAll() ?? []) {
      const record = readStrongRecord(raw);
      if (!record.id || record.id === AI_AGENT_LAYER_ID) continue;
      if (record.enabled !== true || record.count <= 0) continue;
      const point = inspectionPoint(record.id);
      if (!point) continue;
      const event = latestEventFor(record.id);
      out.push({
        layerId: record.id,
        label: record.label,
        count: record.count,
        latDeg: point.latDeg,
        lonDeg: point.lonDeg,
        severity:
          event && nowSource() - event.at < EVENT_MEMORY_MS
            ? eventSeverity(event)
            : 'info',
        error: Boolean(record.error),
        ...(event ? { eventAt: event.at } : {}),
      });
    }
    return out;
  }

  /**
   * Pick where to walk next. `only` narrows the choice to the layers named in
   * the argument — the divert after a feed event — and a failed pick keeps
   * the current target rather than freezing the spider.
   */
  function selectTarget(only = null) {
    const candidates = inspectionCandidates().filter(
      (candidate) => !only || only.has(candidate.layerId),
    );
    const ranked = rankInspectionTargets(candidates, {
      from: { latDeg: spider.latDeg, lonDeg: spider.lonDeg },
      now: nowSource(),
      visitedAt,
      current: target?.layerId ?? null,
    });
    if (!ranked.length) return false;
    target = ranked[0];
    spider.note = '';
    syncNote();
    spider.scanning = false;
    spider.severity = target.severity;
    phase = 'walk';
    return true;
  }

  /** Sit still when there is nowhere worth going. */
  function rest() {
    target = null;
    phase = 'rest';
    restUntil = nowSource() + REST_MS;
    spider.note = '';
    syncNote();
    spider.scanning = false;
  }

  /** Word one finding through the model — a real warning only, rate-bounded. */
  async function maybeBrief(finding) {
    if (finding.severity === 'info' || briefing) return;
    const now = nowSource();
    if (now - lastBriefAt < BRIEF_MIN_INTERVAL_MS) return;
    lastBriefAt = now;
    briefing = true;
    try {
      const sentence = await requestFindingBrief(finding, {
        locale: getLocale(),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      if (!sentence || destroyed) return;
      avatar?.pushEvent({
        kind: 'event-update',
        layerId: AI_AGENT_LAYER_ID,
        label: msg('Sentinel'),
        detail: sentence,
        at: nowSource(),
        severity: 'emergency',
      });
    } finally {
      briefing = false;
    }
  }

  /**
   * The spider reached its target: report what the layer holds, in the
   * operator's language, then scan for a moment before walking on.
   */
  function reportInspection(candidate) {
    const layerName = translateKnown(candidate.label);
    const detail = tn(candidate.count, '{count} record', '{count} records', {
      count: formatNumber(candidate.count),
    });
    const event = {
      kind: 'event-update',
      layerId: AI_AGENT_LAYER_ID,
      label: layerName,
      detail: candidate.error ? `${detail} · ${t('feed down')}` : detail,
      at: nowSource(),
      severity: candidate.severity,
    };
    recentEvents.push(event);
    while (recentEvents.length > 30) recentEvents.shift();
    avatar?.pushEvent(event);
    avatar?.setState(severityNow());
    void maybeBrief({
      layer: layerName,
      count: candidate.count,
      severity: candidate.severity,
      ...(candidate.error ? { error: 'feed unavailable' } : {}),
    });
  }

  /** One animation step: walk, scan, rest, then choose again. */
  function tick(dtSec) {
    if (!enabled || destroyed) return;
    const now = nowSource();
    if (phase === 'rest') {
      if (now >= restUntil && !target && !selectTarget()) rest();
      return;
    }
    if (!target) {
      rest();
      return;
    }
    if (phase === 'walk') {
      const step = stepPatrol(spider, target, dtSec);
      spider.latDeg = step.latDeg;
      spider.lonDeg = step.lonDeg;
      spider.headingRad = step.headingRad;
      gaitRad += step.travelledRad;
      if (spriteFrames.length)
        spider.frame =
          Math.floor(gaitRad / GAIT_RAD_PER_FRAME) % spriteFrames.length;
      if (!step.arrived) return;
      phase = 'scan';
      scanUntil = now + SCAN_MS;
      spider.scanning = true;
      spider.note = translateKnown(target.label);
      spider.severity = target.severity;
      syncNote();
      updateRing();
      reportInspection(target);
      return;
    }
    // phase === 'scan'
    updateRing();
    if (now < scanUntil) return;
    visitedAt[target.layerId] = now;
    spider.scanning = false;
    spider.note = '';
    syncNote();
    target = null;
    rest();
  }

  /** The scan pulse follows the camera: readable from orbit and from low. */
  function updateRing() {
    const height = Number(viewer?.camera?.positionCartographic?.height);
    spider.ringRadiusM = Number.isFinite(height)
      ? Math.max(120_000, height * 0.03)
      : 400_000;
  }

  /** Ride the scene clock, so the walk costs nothing when the page idles. */
  function startAnimation() {
    const preUpdate = viewer?.scene?.preUpdate;
    if (typeof preUpdate?.addEventListener !== 'function') return;
    lastFrameAt = nowSource();
    const onFrame = () => {
      const now = nowSource();
      const dt = Math.min(
        MAX_FRAME_DT_S,
        Math.max(0, (now - lastFrameAt) / 1000),
      );
      lastFrameAt = now;
      if (dt > 0) tick(dt);
    };
    preUpdate.addEventListener(onFrame);
    stopAnimation = () => {
      try {
        preUpdate.removeEventListener(onFrame);
      } catch {
        // A scene being torn down cannot take another removal.
      }
    };
  }

  function stopTicking() {
    try {
      stopAnimation?.();
    } finally {
      stopAnimation = null;
    }
  }

  /** The spider appears where the operator is already looking. */
  function spawnAtCamera() {
    const carto = viewer?.camera?.positionCartographic;
    const lat = Number(carto?.latitude);
    const lon = Number(carto?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      spider.latDeg = toDegrees(lat);
      spider.lonDeg = toDegrees(lon);
      return;
    }
    spider.latDeg = FALLBACK_SPAWN.latDeg;
    spider.lonDeg = FALLBACK_SPAWN.lonDeg;
  }

  function watchCycle() {
    if (!enabled || !manager || typeof manager.getAll !== 'function')
      return severityNow();
    // The roster diff must not watch the agent itself: every finding the
    // layer pushes would read back next cycle as its own news.
    const roster = (manager.getAll() ?? []).filter(
      (raw) => strId(raw) !== AI_AGENT_LAYER_ID,
    );
    const { events, previous } = watchLayers(roster, watchState, {
      now: nowSource,
      readRecords: readStrongRecord,
    });
    watchState.previous = previous;
    for (const event of events) {
      recentEvents.push(event);
      // Feed errors are what the operator reads; a record-count delta is
      // weather, not news — it only steers the spider.
      if (event.kind === 'layer-error')
        avatar?.pushEvent({
          ...event,
          label: translateKnown(event.label),
        });
    }
    while (recentEvents.length > 30) recentEvents.shift();
    const fresh = freshEvents();
    const freshSeverity = worstSeverity(fresh);
    divert(fresh);
    lastSeen = nowSource();
    return freshSeverity === 'info' ? severityNow() : freshSeverity;
  }

  /**
   * A layer that just broke (or escalated) pulls the spider: it abandons the
   * walk and heads there, unless it already reported that layer since the
   * event landed. Purely local — the operator's view does not move.
   */
  function divert(fresh) {
    if (!fresh.length) return;
    const wanted = new Set();
    for (const event of fresh) {
      if (eventSeverity(event) === 'info') continue;
      if (event.layerId === AI_AGENT_LAYER_ID) continue;
      if (Number(visitedAt[event.layerId]) >= Number(event.at)) continue;
      if (target?.layerId === event.layerId && phase === 'walk') continue;
      wanted.add(event.layerId);
    }
    if (!wanted.size) return;
    selectTarget(wanted);
  }

  function severityNow() {
    const fresh = freshEvents(60_000);
    if (!fresh.length) return 'idle';
    const worst = worstSeverity(fresh);
    return worst === 'info' ? 'info' : worst;
  }

  const layer = {
    id: AI_AGENT_LAYER_ID,
    name: msg('Sentinel'),
    icon: '🕷️',
    source: 'Local patrol spider · optional model for one sentence',
    // The manager arms its own periodic update() calls at this cadence.
    updateInterval: WATCH_INTERVAL_MS,

    attachDataManager(registeredManager) {
      manager = registeredManager;
    },

    init(appViewer) {
      if (viewer) throw new Error('AI agent layer is already initialized');
      viewer = appViewer;
      if (document) avatar = createAvatarOverlay({ doc: document });
      spriteFrames = spiderSpriteFrames({ doc: document });
      body = createSpiderBody({ viewer, frames: spriteFrames, state: spider });
      spawnAtCamera();
      spider.visible = false;
      avatar?.setState('idle');
      restUntil = nowSource();
      return true;
    },

    enable() {
      if (destroyed) return false;
      enabled = true;
      spider.visible = true;
      avatar?.setSleeping(false);
      watchCycle();
      if (!selectTarget()) rest();
      startAnimation();
      return true;
    },

    disable() {
      enabled = false;
      spider.visible = false;
      spider.scanning = false;
      spider.note = '';
      syncNote();
      stopTicking();
      avatar?.setSleeping(true);
      return true;
    },

    /** The manager's status tick: diff the roster, divert if something broke. */
    async update() {
      if (!enabled || destroyed) return false;
      watchCycle();
      avatar?.setState(severityNow());
      if (!target && nowSource() >= restUntil && !selectTarget()) rest();
      return true;
    },

    destroy() {
      destroyed = true;
      enabled = false;
      stopTicking();
      spider.visible = false;
      try {
        body?.destroy();
      } catch {
        // The scene may already be gone with the page.
      }
      body = null;
      destroySpiderNoteOverlay();
      try {
        avatar?.destroy();
      } catch {
        // The card can already be gone with its host document.
      }
      avatar = null;
      target = null;
      manager = null;
      viewer = null;
      return true;
    },

    getStats() {
      const fresh = freshEvents();
      return {
        count: fresh.length,
        lastUpdate: lastSeen,
        loading: false,
        emptyHint:
          'The Sentinel spider walks the globe, inspects enabled layers and reports what each one holds.',
        mode: body ? 'patrol' : 'watchdog',
        target: target?.layerId ?? null,
      };
    },
  };

  return layer;
}
