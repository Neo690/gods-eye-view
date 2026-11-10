// The Sentinel data layer ("AI Agent" is the id it keeps, "Sentinel" what it
// shows): a glowing orb that travels the globe instead of an avatar that
// watches it from a corner.
//
//   - the watchdog (watch.js) still diffs the data-layer roster every cycle,
//     so a feed that breaks is news the operator reads,
//   - the spider (spider.js) walks the surface: it picks one inspection target
//     among the enabled layers (patrol.js ranks them by severity, feed health,
//     freshness, distance and how long ago it looked), crawls to the nearest
//     record of the chosen layer, scans it and reports what the layer holds,
//   - when S2 GhostMaps is enabled its alerts take the tour in severity order:
//     the view flies to each alert, its own report card opens, and the spider
//     walks in to scan it before moving to the next one, and says its headline
//     aloud through the device voice. The layer row holds a VOICE chip that
//     mutes the announcements and a PAUSE TOUR chip that freezes the tour
//     where it stands — open card, camera and remaining reading time included —
//     and resumes it from there,
//   - the patrol is local and deterministic. Nothing here changes the
//     operator's layers; the GhostMaps alert tour is the only camera motion,
//   - a model is optional and only ever words a finding that matters
//     (brief.js), at most once every twenty minutes. With no key the layer is
//     exactly as useful, and spends nothing.
// The body is Cesium entities; the inspection note rides the world-overlay
// host (entity labels are forbidden); the report card is DOM (see overlay.js),
// so disabling the layer removes all three with no cleanup left behind.
import * as Cesium from 'cesium';
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
  CRUISE_RAD_PER_S,
  TURN_RAD_PER_S,
  REST_MS,
  SCAN_MS,
  toDegrees,
} from './patrol.js';
import { requestFindingBrief, BRIEF_MIN_INTERVAL_MS } from './brief.js';
import { createSpiderCameraFollow } from './follow.js';
import { createAlertVoice } from './voice.js';

export const AI_AGENT_LAYER_ID = 'ai-agent';

/** Manager cadence: one roster diff per cycle. */
const WATCH_INTERVAL_MS = 30 * 1000;

/** Events older than this stop pulling the spider and ranking targets. */
const EVENT_MEMORY_MS = 10 * 60 * 1000;

/** Positions sampled from one layer when looking for its nearest record. */
const PULSE_SAMPLE = 512;

/** Pulse rate of the orb in cycles per second, so the frame counter is a
 *  wall-clock phase and never tied to the walk's distance. */
const PULSE_HZ = 0.75;

/** Where the spider appears when the camera cannot say where it looks. */
const FALLBACK_SPAWN = Object.freeze({ latDeg: 20, lonDeg: 0 });

/** Longest stretch of time one frame may advance the walk. */
const MAX_FRAME_DT_S = 0.25;

/** The one layer whose alerts get a guided tour instead of a plain scan. */
const ALERT_LAYER_ID = 's2-ghostmaps';

/** Keep the alert fly-to near the operator's current altitude, within reason. */
const ALERT_TOUR_MIN_HEIGHT_M = 400_000;
const ALERT_TOUR_MAX_HEIGHT_M = 1_500_000;
const ALERT_TOUR_FLIGHT_MS = 2500;
/** Between two alerts the view pulls back to a regional shot first. */
const ALERT_TOUR_PULLBACK_HEIGHT_M = 6_000_000;
const ALERT_TOUR_PULLBACK_FLIGHT_MS = 1200;
const ALERT_TOUR_PULLBACK_MS = 2000;
/** A detailed card needs longer than a generic scan to be read. The tour
 *  waits for the headline to be read AND spoken: a fixed seven seconds cut
 *  the voice off mid-sentence, so the reading time follows the text. */
export const ALERT_READ_BASE_MS = 9000;
export const ALERT_READ_PER_CHAR_MS = 80;
export const ALERT_READ_MAX_MS = 22000;

/**
 * How long one alert stays on screen: enough to read its headline and hear
 * the sentence, longer for longer headlines, capped so the tour still moves.
 * @param {string} text The spoken/displayed headline.
 * @returns {number} Milliseconds to hold the card open.
 */
export function alertReadMs(text) {
  const chars = String(text ?? '').trim().length;
  return Math.min(
    ALERT_READ_MAX_MS,
    ALERT_READ_BASE_MS + chars * ALERT_READ_PER_CHAR_MS,
  );
}

/** Alerts are toured briskly: the card carries the detail, the walk is
 *  theatre. Eight times cruise keeps a cross-globe hop under ten seconds; the
 *  turn rate scales with it, or a long stride circles the pole instead of
 *  settling on a target on the other side of it. */
const ALERT_WALK_LIMITS = Object.freeze({
  speed: CRUISE_RAD_PER_S * 8,
  turn: TURN_RAD_PER_S * 8,
});

/**
 * Wire the spider to what the application owns.
 *
 * @param {object} [options]
 * @param {{doc?: Document}} [options.docScope] test seam for the report card.
 * @param {() => number} [options.now] clock seam.
 * @param {Function} [options.fetchImpl] relay seam for the optional brief.
 * @param {object} [options.overlayHost] the world-overlay adapter (see
 *   `src/app/layers/overlayHost.js`); without one the inspection note stays
 *   silent rather than reaching across the package boundary.
 * @param {object} [options.voice] spoken-alert seam (see voice.js); without
 *   one the layer creates the device voice on init.
 * @returns {object} data-layer module (lifecycle contract).
 */
export function createAiAgentLayer({
  docScope = undefined,
  now: nowSource = Date.now,
  fetchImpl = undefined,
  overlayHost: noteOverlayHost = null,
  voice: voiceSource = null,
} = {}) {
  let document = docScope ?? globalThis.document;
  let manager = null;
  let viewer = null;
  let avatar = null;
  let body = null;
  let follow = null;
  let enabled = false;
  let destroyed = false;
  let stopAnimation = null;

  // Watchdog memory (watchLayers owns its shapes).
  const watchState = { previous: null, seen: new Set() };
  const recentEvents = [];
  const visitedAt = {};
  // Alerts already scanned in this edition. A new GhostMaps commit (or a
  // changed feature count) starts the tour over from the most severe one.
  const visitedAlerts = new Set();
  // The card this layer opened, so a manual GhostMaps click is never closed
  // by the tour moving on or by the layer being switched off.
  let activeAlertId = null;
  let lastSeen = null;

  // The spider's own state, read by the Cesium callbacks every frame.
  const spider = {
    latDeg: FALLBACK_SPAWN.latDeg,
    lonDeg: FALLBACK_SPAWN.lonDeg,
    headingRad: 0,
    frame: 0,
    visible: false,
    scanning: false,
    ringRadiusM: 150_000,
    note: '',
    severity: 'info',
  };
  let spriteFrames = [];
  let pulsePhase = 0;
  let target = null;
  let phase = 'rest';
  let scanUntil = 0;
  let restUntil = 0;
  let pullbackUntil = 0;
  let lastFrameAt = 0;
  let lastBriefAt = 0;
  let briefing = false;

  // Opt-in gentle camera follow (see follow.js): off until the operator
  // ticks the layer's row chip, and never resurrected by a reload.
  let followEnabled = false;
  // The operator's hold on the tour. A paused tour keeps its target, its open
  // card and the time each phase had left, so resuming carries on rather than
  // restarting the alert.
  let tourPaused = false;
  let pausedAt = 0;
  let rowControlsListener = null;
  // The alert voice: on by default, muted from the layer row. Announcing is
  // theatre on top of the card, never the operator's only copy of the news.
  let voice = voiceSource;
  const notifyRow = () => rowControlsListener?.();

  const strId = (raw) => String(raw?.id ?? '');

  /** The world-overlay entry that names what the spider is inspecting rides
   * wherever `spider.note` changes, so the caption can never stale behind the
   * walk. Entry graphics are forbidden for this (noCesiumLabels). A vanishing
   * note removes the entry rather than drawing an empty caption. Without an
   * injected host there is simply no caption.
   */
  function syncNote() {
    if (destroyed) return;
    syncSpiderNoteOverlay({ state: spider, host: noteOverlayHost });
  }

  /** Events about a layer still fresh enough to matter. */
  function freshEvents(withinMs = EVENT_MEMORY_MS) {
    const now = nowSource();
    return recentEvents.filter((event) => now - event.at < withinMs);
  }

  /** The GhostMaps layer module, only while that layer is actually on. */
  function ghostMapsModule() {
    const entry = manager?.layers?.get?.(ALERT_LAYER_ID);
    const module = entry?.module;
    if (!module || entry.enabled === false) return null;
    return typeof module.getSentinelAlerts === 'function' ? module : null;
  }

  /**
   * The next GhostMaps alert the tour has not read, most severe first. The
   * layer did the ranking; this only keeps the visited book. A new edition
   * keeps the book too: it prunes alerts that disappeared instead of starting
   * over from the same first headline every time the source polls. The book
   * lives as long as the layer does, so re-enabling the tour resumes it.
   */
  function ghostMapsAlertTarget() {
    const module = ghostMapsModule();
    if (!module) return null;
    let alerts = [];
    try {
      alerts = module.getSentinelAlerts() || [];
    } catch {
      return null; // a throwing reader is the same as no reader
    }
    if (visitedAlerts.size) {
      const live = new Set(alerts.map((alert) => String(alert.id)));
      for (const id of [...visitedAlerts])
        if (!live.has(id)) visitedAlerts.delete(id);
    }
    const next = alerts.find((alert) => !visitedAlerts.has(String(alert.id)));
    if (!next) return null;
    const latDeg = Number(next.latDeg);
    const lonDeg = Number(next.lonDeg);
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;
    return {
      kind: 'ghostmaps-alert',
      layerId: ALERT_LAYER_ID,
      alertId: String(next.id),
      label: next.name || next.folder || msg('S2 GhostMaps'),
      folder: next.folder || '',
      count: 1,
      latDeg,
      lonDeg,
      severity:
        next.severity === 'emergency' || next.severity === 'warn'
          ? next.severity
          : 'info',
      score: Number(next.score) || 0,
      summary: next.summary || '',
    };
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
    // The GhostMaps alert tour outranks the generic layer patrol. A divert
    // (only) still wins: a feed that just broke is the operator's news.
    if (!only) {
      const alert = ghostMapsAlertTarget();
      if (alert) {
        adoptTarget(alert);
        return true;
      }
    }
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
    adoptTarget(ranked[0]);
    return true;
  }

  /** Make one target current, flying the view there for a GhostMaps alert. */
  function adoptTarget(next) {
    target = next;
    spider.note = '';
    syncNote();
    spider.scanning = false;
    spider.severity = target.severity;
    phase = 'walk';
    if (target.kind === 'ghostmaps-alert') flyToAlert(target);
  }

  /** One top-down camera flight, with the alert tour's easing. */
  function flyCamera(lonDeg, latDeg, heightM, durationMs) {
    const camera = viewer?.camera;
    if (typeof camera?.flyTo !== 'function') return;
    try {
      camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, heightM),
        orientation: {
          heading: 0,
          pitch: -Cesium.Math.PI_OVER_TWO,
          roll: 0,
        },
        duration: durationMs / 1000,
      });
    } catch {
      // A camera torn down mid-tour cannot take another flight.
    }
  }

  /** Frame the alert without changing how far out the operator already is. */
  function flyToAlert(alert) {
    const height = Number(viewer?.camera?.positionCartographic?.height);
    const safeHeight = Number.isFinite(height)
      ? Math.min(
          ALERT_TOUR_MAX_HEIGHT_M,
          Math.max(ALERT_TOUR_MIN_HEIGHT_M, height),
        )
      : ALERT_TOUR_MIN_HEIGHT_M;
    flyCamera(alert.lonDeg, alert.latDeg, safeHeight, ALERT_TOUR_FLIGHT_MS);
  }

  /** Leave the scanned alert for a wide shot before choosing the next one. */
  function pullBackFromAlert() {
    flyCamera(
      spider.lonDeg,
      spider.latDeg,
      ALERT_TOUR_PULLBACK_HEIGHT_M,
      ALERT_TOUR_PULLBACK_FLIGHT_MS,
    );
  }

  /**
   * Hold the tour where it stands, or pick it up again.
   *
   * The phases run on wall-clock deadlines (scanUntil, pullbackUntil,
   * restUntil), so a resume shifts each by the time spent paused: an alert
   * that had two seconds of reading left still has two seconds left, instead
   * of being cut short by the pause.
   */
  function setTourPaused(paused) {
    if (destroyed || Boolean(paused) === tourPaused) return;
    tourPaused = Boolean(paused);
    if (tourPaused) {
      pausedAt = nowSource();
    } else {
      const held = Math.max(0, nowSource() - pausedAt);
      pausedAt = 0;
      if (scanUntil) scanUntil += held;
      if (pullbackUntil) pullbackUntil += held;
      if (restUntil) restUntil += held;
    }
    notifyRow();
  }

  /** Sit still when there is nowhere worth going. */
  function rest() {
    target = null;
    phase = 'rest';
    pullbackUntil = 0;
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

  /**
   * Say the alert the tour just reached. The card carries the full popup; the
   * voice carries its headline, once, in the operator's language. A hidden
   * page, a muted voice or a device without a synthesiser says nothing.
   */
  function announceAlert(candidate) {
    if (!voice?.isEnabled?.()) return;
    if (document?.hidden === true) return;
    voice.announce(candidate.summary || candidate.label);
  }

  /** The spider reached a GhostMaps alert: its card is open, so report it. */
  function reportAlert(candidate) {
    const layerName = translateKnown(candidate.label);
    // The card carries the full popup; this is the one-line feed summary.
    const detail = candidate.summary || candidate.label;
    const event = {
      kind: 'event-update',
      layerId: AI_AGENT_LAYER_ID,
      label: layerName,
      detail,
      at: nowSource(),
      severity: candidate.severity,
    };
    recentEvents.push(event);
    while (recentEvents.length > 30) recentEvents.shift();
    avatar?.pushEvent(event);
    avatar?.setState(severityNow());
    void maybeBrief({
      layer: layerName,
      count: 1,
      severity: candidate.severity,
    });
    announceAlert(candidate);
  }

  /** Close only this tour's card and stop its camera flight. */
  function clearAlertTour() {
    if (activeAlertId) {
      ghostMapsModule()?.clearSentinelInspection?.(activeAlertId);
      activeAlertId = null;
    }
    if (target?.kind === 'ghostmaps-alert' || phase === 'pullback') {
      try {
        viewer?.camera?.cancelFlight?.();
      } catch {
        // A camera torn down mid-tour cannot take another cancellation.
      }
    }
  }

  /** One animation step: walk, scan, rest, then choose again.
   *
   * The orb's glow breathes on the clock while the walk itself stays tied to
   * distance, so a crawling frame-tracker (throttled page, idle GPU) still
   * pulses at a steady rate without walking further faster.
   */
  function tick(dtSec) {
    if (!enabled || destroyed) return;
    if (spriteFrames.length) {
      pulsePhase += dtSec * PULSE_HZ;
      spider.frame = Math.floor(pulsePhase) % spriteFrames.length;
    }
    // Held: the orb keeps breathing but the walk, the scan and the camera
    // flights all wait. The open card stays for reading.
    if (tourPaused) return;
    const now = nowSource();
    if (phase === 'rest') {
      if (now >= restUntil && !target && !selectTarget()) rest();
      return;
    }
    if (phase === 'pullback') {
      if (now < pullbackUntil) return;
      if (!selectTarget()) rest();
      return;
    }
    if (!target) {
      rest();
      return;
    }
    if (phase === 'walk') {
      const step = stepPatrol(
        spider,
        target,
        dtSec,
        target.kind === 'ghostmaps-alert' ? ALERT_WALK_LIMITS : undefined,
      );
      spider.latDeg = step.latDeg;
      spider.lonDeg = step.lonDeg;
      spider.headingRad = step.headingRad;
      if (!step.arrived) return;
      phase = 'scan';
      scanUntil =
        now +
        (target.kind === 'ghostmaps-alert'
          ? alertReadMs(target.summary || target.label)
          : SCAN_MS);
      spider.scanning = true;
      spider.note = translateKnown(target.label);
      spider.severity = target.severity;
      syncNote();
      updateRing();
      if (target.kind === 'ghostmaps-alert') {
        const opened = ghostMapsModule()?.inspectSentinelAlert?.(
          target.alertId,
        );
        if (opened) activeAlertId = target.alertId;
        reportAlert(target);
      } else {
        reportInspection(target);
      }
      return;
    }
    // phase === 'scan'
    updateRing();
    if (now < scanUntil) return;
    if (target.kind === 'ghostmaps-alert') {
      visitedAlerts.add(target.alertId);
      // Close only this alert's card: a click on another pin during the scan
      // belongs to the operator and stays open.
      ghostMapsModule()?.clearSentinelInspection?.(target.alertId);
      if (activeAlertId === target.alertId) activeAlertId = null;
      spider.scanning = false;
      spider.note = '';
      syncNote();
      target = null;
      // Hold over the scanned alert, pull back, then pick the next one from
      // the wide shot. The pause also makes the transition read as a move.
      phase = 'pullback';
      pullbackUntil = now + ALERT_TOUR_PULLBACK_MS;
      pullBackFromAlert();
      return;
    }
    visitedAt[target.layerId] = now;
    spider.scanning = false;
    spider.note = '';
    syncNote();
    target = null;
    rest();
  }

  /** The scan pulse follows the camera: readable from orbit and from low, at
   *  a tight 1% of the altitude so the ring never swallows the view. */
  function updateRing() {
    const height = Number(viewer?.camera?.positionCartographic?.height);
    spider.ringRadiusM = Number.isFinite(height)
      ? Math.max(20_000, height * 0.01)
      : 150_000;
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
      // After the walk advanced: the camera chases where the spider now is,
      // and it is the walk's dt so a throttled frame cannot outpace it.
      if (dt > 0 && followEnabled) follow?.step(dt);
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
    if (!fresh.length || tourPaused) return;
    // A GhostMaps alert owns the view and its card until the scan ends; a
    // feed-count wobble must not yank the operator away mid-alert.
    if (target?.kind === 'ghostmaps-alert' || phase === 'pullback') return;
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
      if (!voice) voice = createAlertVoice({ locale: () => getLocale() });
      follow = createSpiderCameraFollow({
        camera: viewer?.camera,
        canvas: viewer?.canvas ?? viewer?.scene?.canvas,
        state: spider,
      });
      follow.setEnabled(followEnabled);
      spawnAtCamera();
      spider.visible = false;
      avatar?.setState('idle');
      restUntil = nowSource();
      return true;
    },

    enable() {
      if (destroyed) return false;
      enabled = true;
      // The tour resumes where it stopped: the visited book survives a
      // disable/enable, so the same severe headlines do not replay first.
      tourPaused = false;
      pausedAt = 0;
      spider.visible = true;
      avatar?.setSleeping(false);
      // The tick stalls before the follow does its one gate read: a hidden
      // spider already stops the drift, so re-arming is a mirror of the flag.
      follow?.setEnabled(followEnabled);
      watchCycle();
      if (!selectTarget()) rest();
      startAnimation();
      return true;
    },

    disable() {
      enabled = false;
      // A sentence about an alert the tour abandoned is stale.
      voice?.stop?.();
      clearAlertTour();
      spider.visible = false;
      spider.scanning = false;
      spider.note = '';
      syncNote();
      stopTicking();
      // The drift rides the same animation loop; without it, nothing moves.
      follow?.setEnabled(false);
      avatar?.setSleeping(true);
      return true;
    },

    /** The manager's status tick: diff the roster, divert if something broke. */
    async update() {
      if (!enabled || destroyed) return false;
      watchCycle();
      avatar?.setState(severityNow());
      // A paused tour still reads the roster (a broken feed is news), but it
      // neither moves the camera nor picks the next alert.
      if (tourPaused) return true;
      if (phase === 'pullback') return true;
      if (!target && nowSource() >= restUntil && !selectTarget()) rest();
      return true;
    },

    destroy() {
      destroyed = true;
      enabled = false;
      clearAlertTour();
      stopTicking();
      spider.visible = false;
      try {
        body?.destroy();
      } catch {
        // The scene may already be gone with the page.
      }
      body = null;
      destroySpiderNoteOverlay(noteOverlayHost);
      follow?.destroy();
      follow = null;
      voice?.destroy?.();
      voice = null;
      rowControlsListener = null;
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

    /**
     * The Layers row's controls: the alert voice, the tour's hold, and an
     * opt-in checkbox that asks the view to follow the sentinel gently.
     * Re-read live on every render, so a stale chip can never flip a toggle
     * the wrong way.
     */
    getRowControls() {
      return {
        chips: [
          {
            id: 'voice',
            label: t('VOICE'),
            active: voice?.isEnabled?.() === true,
            title: t('Read each GhostMaps alert aloud as the tour reaches it'),
            onClick: () => {
              voice?.setEnabled?.(voice.isEnabled() !== true);
              notifyRow();
            },
          },
          {
            id: 'pause-tour',
            label: tourPaused ? t('RESUME TOUR') : t('PAUSE TOUR'),
            active: tourPaused,
            title: tourPaused
              ? t('Pick the tour up where it stopped')
              : t(
                  'Hold the tour: no camera flight, no next alert, the open card stays',
                ),
            onClick: () => setTourPaused(!tourPaused),
          },
          {
            id: 'follow',
            label: t('FOLLOW CAMERA'),
            active: followEnabled,
            title: t(
              'Drift the view to the Sentinel as it patrols; paused while you drag or zoom',
            ),
            onClick: () => {
              followEnabled = !followEnabled;
              follow?.setEnabled(followEnabled);
              notifyRow();
            },
          },
        ],
      };
    },

    setRowControlsListener(value) {
      rowControlsListener = typeof value === 'function' ? value : null;
    },

    /** Drop the panel's listener; the panel may outlive this layer. */
    clearRowControlsListener() {
      rowControlsListener = null;
    },

    getStats() {
      const fresh = freshEvents();
      return {
        count: fresh.length,
        lastUpdate: lastSeen,
        loading: false,
        // Live patrol readout: where the body stands, which pulse frame it
        // shows, whether the scan ring is open and what it is reading.
        latDeg: spider.latDeg,
        lonDeg: spider.lonDeg,
        frame: spider.frame,
        scanning: spider.scanning,
        note: spider.note,
        severity: spider.severity,
        ringRadiusM: spider.ringRadiusM,
        emptyHint:
          'The Sentinel spider walks the globe, inspects enabled layers and reports what each one holds.',
        mode: body ? 'patrol' : 'watchdog',
        target: target?.layerId ?? null,
        targetKind: target?.kind ?? null,
        alert: target?.alertId ?? null,
        alertsVisited: visitedAlerts.size,
        paused: tourPaused,
        voice: voice?.isEnabled?.() === true,
      };
    },
  };

  return layer;
}
