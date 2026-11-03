// The AI Sentinel data layer ("AI Agent").
//
// One toggle in the data-layer panel starts an autonomous watch agent:
//   - the watchdog (watch.js) diffs the data-layer roster every cycle and
//     surfaces layer health/data events into the alert feed (overlay.js),
//   - on a slower cadence — and whenever a warn/emergency event lands — the
//     planner (planner.js) asks the operator-configured model for a plan and
//     executes it through THE SAME action runner the voice console uses, so
//     the agent's capability is exactly the operator's existing tool set,
//   - with no model configured the layer stays watchdog-only: alerts still
//     surface, nothing executes, nothing costs.
// The layer owns no map primitives: the avatar is DOM (see overlay.js), so
// disabling the layer removes the agent with no Cesium cleanup.
import { msg } from '../../i18n/index.js';
import {
  watchLayers,
  worstSeverity,
  readStrongRecord,
} from './watch.js';
import { createAvatarOverlay } from './overlay.js';
import { requestAgentPlan, MAX_ACTIONS_PER_SESSION } from './planner.js';

export const AI_AGENT_LAYER_ID = 'ai-agent';

/** One watchdog pass per cycle... */
const WATCH_INTERVAL_MS = 30 * 1000;
/** ...and one planning pass at most every 5 minutes. */
const PLAN_INTERVAL_MS = 5 * 60 * 1000;
/** First planning pass: let feeds settle after the toggle. */
const FIRST_PLAN_DELAY_MS = 45 * 1000;
/** Events older than this stop motivating a plan. */
const EVENT_MEMORY_MS = 10 * 60 * 1000;


/**
 * Wire the Sentinel engine to what the application owns. The action runner
 * and the style manager are attached by the application bootstrap (the same
 * objects the voice console uses), so the agent never constructs privileged
 * access itself.
 *
 * @param {object} [options]
 * @param {{doc?: Document}} [options.docScope] Test seam for the avatar.
 * @returns {object} data-layer module (lifecycle contract).
 */
export function createAiAgentLayer({
  docScope = undefined,
  now: nowSource = Date.now,
} = {}) {
  let document = docScope ?? globalThis.document;
  let manager = null;
  let viewer = null;
  let styleManager = null;
  let runner = null;
  let avatar = null;
  let enabled = false;
  let destroyed = false;

  // Watchdog memory (watchLayers owns its shapes).
  const watchState = { previous: null, seen: new Set() };
  const recentEvents = [];
  let actionsUsed = 0;
  let lastSeen = null;
  let planAt = 0;
  let planning = false;

  function forgetOldEvents() {
    const now = nowSource();
    while (
      recentEvents.length &&
      now - recentEvents[0].at > EVENT_MEMORY_MS
    ) {
      recentEvents.shift();
    }
  }

  function watchCycle() {
    if (!enabled || !manager || typeof manager.getAll !== 'function')
      return severityNow();
    const rows = manager.getAll();
    const { events, previous } = watchLayers(rows, watchState, {
      now: nowSource(),
      readRecords: readStrongRecord,
    });
    watchState.previous = previous;
    for (const event of events) {
      recentEvents.push(event);
      avatar?.pushEvent(event);
    }
    while (recentEvents.length > 30) recentEvents.shift();
    forgetOldEvents();
    const fresh = recentEvents.filter((event) => nowSource() - event.at < 60_000);
    const freshSeverity = worstSeverity(fresh);
    if (freshSeverity !== 'info') planAt = Math.min(planAt, nowSource() + 15_000);
    lastSeen = nowSource();
    return freshSeverity;
  }

  function severityNow() {
    if (!recentEvents.length) return 'idle';
    const fresh = recentEvents.filter(
      (event) => nowSource() - event.at < 60_000,
    );
    if (!fresh.length) return 'idle';
    const worst = worstSeverity(fresh);
    return worst === 'info' ? 'info' : worst;
  }

  async function planCycle() {
    if (!enabled || planning || destroyed) return;
    if (nowSource() < planAt) return;
    if (!runner) return; // watchdog-only mode: no privileged access attached
    const fresh = recentEvents.filter(
      (event) => nowSource() - event.at < EVENT_MEMORY_MS,
    );
    if (actionsUsed >= MAX_ACTIONS_PER_SESSION) return;
    planning = true;
    avatar?.clearFreeze();
    try {
      const plan = await requestAgentPlan(
        { viewer, dataManager: manager, styleManager },
        { events: fresh, actCount: actionsUsed },
      );
      if (!plan || !plan.actions.length) {
        if (plan?.speech) {
          const event = {
            kind: 'event-update',
            layerId: AI_AGENT_LAYER_ID,
            label: msg('Sentinel'),
            detail: plan.speech,
            at: nowSource(),
          };
          recentEvents.push(event);
          avatar?.pushEvent(event);
        }
        return;
      }
      let used = 0;
      const usedNames = [];
      for (const action of plan.actions) {
        if (actionsUsed + used >= MAX_ACTIONS_PER_SESSION) break;
        try {
          await runner(action.name, action.args, {});
          used += 1;
          usedNames.push(action.name);
        } catch (error) {
          // An action failing is operational, not fatal: report and continue.
          const event = {
            kind: 'layer-error',
            layerId: action.name,
            label: action.name,
            detail: String(error?.message || error).slice(0, 120),
            at: nowSource(),
          };
          recentEvents.push(event);
          avatar?.pushEvent(event);
        }
      }
      actionsUsed += used;
      if (plan.speech || usedNames.length) {
        const event = {
          kind: 'event-update',
          layerId: AI_AGENT_LAYER_ID,
          label: usedNames.length
            ? `${plan.speech || 'Action'} — ${usedNames.join(', ')}`
            : plan.speech,
          at: nowSource(),
        };
        recentEvents.push(event);
        avatar?.pushEvent(event);
        avatar?.showActions(usedNames);
        planAt = nowSource() + PLAN_INTERVAL_MS;
      }
    } finally {
      planning = false;
      avatar?.setState(severityNow());
    }
  }

  const layer = {
    id: AI_AGENT_LAYER_ID,
    name: msg('AI Agent'),
    icon: '🛰️',
    source: 'Operator-configured model · autonomous watch agent',
    // The manager arms its own periodic update() calls at this cadence; the
    // watchdog is exactly one roster diff per cycle.
    updateInterval: WATCH_INTERVAL_MS,

    attachDataManager(registeredManager) {
      manager = registeredManager;
    },

    /** Bootstrap hook: the same privileged objects the voice console gets. */
    attachActionControl({ actionRunner, styleManager: styles } = {}) {
      if (typeof actionRunner === 'function') runner = actionRunner;
      if (styles && typeof styles === 'object') styleManager = styles;
    },

    init(appViewer) {
      if (viewer) throw new Error('AI agent layer is already initialized');
      viewer = appViewer;
      if (document) avatar = createAvatarOverlay({ doc: document });
      avatar?.setState('idle');
      planAt = nowSource() + FIRST_PLAN_DELAY_MS;
      return true;
    },

    enable() {
      if (destroyed) return false;
      enabled = true;
      avatar?.setSleeping(false);
      watchCycle();
      return true;
    },

    disable() {
      enabled = false;
      avatar?.setSleeping(true);
      return true;
    },

    /** The manager's status tick: watch, surface, decide. */
    async update() {
      if (!enabled || destroyed) return false;
      const severity = watchCycle();
      avatar?.setState(severity);
      void planCycle();
      return true;
    },

    destroy() {
      destroyed = true;
      enabled = false;
      try {
        avatar?.destroy();
      } catch {
        // The overlay can already be gone with its host document.
      }
      avatar = null;
      manager = null;
      runner = null;
      viewer = null;
      return true;
    },

    getStats() {
      forgetOldEvents();
      return {
        count: recentEvents.length,
        lastUpdate: lastSeen,
        loading: false,
        emptyHint:
          'The Sentinel watches enabled layers and, with a model configured, plans layer/search/camera actions on the same voice tool set.',
        mode: runner ? 'autonomous' : 'watchdog',
      };
    },
  };

  return layer;
}
