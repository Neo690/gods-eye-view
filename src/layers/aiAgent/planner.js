// AI-agent planning loop and action execution.
//
// The avatar watches (watch.js) and shows (overlay.js); this module decides.
// One cycle asks the operator-configured model — via the same-origin
// `/api/openai/agent-plan` relay, which keeps the key server-side — for a plan
// given the current World Packet plus recent events, then executes the plan's
// actions through the SAME runner the voice tools use, so the agent can never
// do anything the voice console could not: schema-checked actions, the same
// caps, the same audit paths. A plan without a model (no key, relay down,
// unparseable answer) degrades to watchdog-only mode: events still surface,
// no actions run, no cost accrues.
import { getWorldPacket } from '../../agent/worldPacket.js';

const PLAN_URL = '/api/openai/agent-plan';

/** Actions the agent may execute per cycle and per session. */
export const MAX_ACTIONS_PER_PLAN = 3;
export const MAX_ACTIONS_PER_SESSION = 12;

const SAFE_ACTION_NAMES = new Set([
  'set_layer_visibility',
  'zoom_to_globe',
  'focus_city',
  'toggle_hud',
  'adjust_camera_heading',
]);

/**
 * Keep only schema-known, agent-safe actions. `set_layer_visibility` refuses
 * to disable 'ai-agent' itself: an agent that switches itself off mid-plan
 * would leave the session in an ambiguous lifecycle state.
 * @param {unknown} actions
 * @returns {Array<{name:string,args:object}>}
 */
export function safePlanActions(actions) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (const action of actions.slice(0, MAX_ACTIONS_PER_PLAN)) {
    if (!action || typeof action !== 'object') continue;
    const name = typeof action.action === 'string' ? action.action : '';
    if (name === 'set_layer_visibility') {
      const args = action.args && typeof action.args === 'object' ? action.args : {};
      const layerId = String(args.layerId || '');
      if (!layerId || layerId === 'ai-agent') continue;
    } else if (!SAFE_ACTION_NAMES.has(name)) {
      continue;
    }
    out.push({
      name,
      args:
        action.args && typeof action.args === 'object' ? { ...action.args } : {},
    });
  }
  return out;
}

/**
 * Build the planning request the server relays. Kept as a pure function so
 * tests can pin what the model actually receives.
 * @param {{viewer:object, dataManager:object, styleManager:object}} owners
 * @param {{events: Array<object>, actCount: number}} context
 * @returns {{instructions:string,input:object}}
 */
export function buildAgentPlanRequest({ viewer, dataManager, styleManager }, { events = [], actCount = 0 } = {}) {
  return {
    instructions: [
      'You are Sentinel, an autonomous watch agent inside Gods Eye View.',
      'You receive the current World Packet: camera, enabled data layers, feed health and provenance.',
      'You may change layers, search, fly the camera and manage the HUD, at most 3 actions,',
      'acting only on what the packet shows and never inventing facts.',
      'Answer ONLY JSON: {"speech": string, "actions": [{"action": string, "args": object}]}',
      'Stay quiet when nothing warrants action: an empty actions list is a valid plan.',
    ].join(' '),
    input: {
      worldPacket: getWorldPacket({ viewer, dataManager, styleManager }),
      recentEvents: events.slice(-8).map((event) => ({
        kind: event.kind,
        layer: event.layerId,
        detail: event.detail || '',
      })),
      spentActions: actCount,
      maxActions: MAX_ACTIONS_PER_SESSION,
    },
  };
}

/**
 * One planning cycle against the relay. Returns null when the plan is not
 * actionable (relay missing, keyless, upstream error, unparseable answer).
 * @param {{viewer:object, dataManager:object, styleManager:object}} owners
 * @param {{events: Array<object>, actCount: number}} context
 * @param {{fetchImpl?: Function}} [options]
 * @returns {Promise<{speech:string, actions: Array<{name:string,args:object}>}|null>}
 */
export async function requestAgentPlan(owners, context, { fetchImpl = fetch } = {}) {
  if (!owners?.viewer?.camera || typeof owners?.dataManager?.getAll !== 'function')
    return null;
  let payload;
  try {
    payload = buildAgentPlanRequest(owners, context);
  } catch {
    return null;
  }
  try {
    const response = await fetchImpl(PLAN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data?.plan || typeof data.plan !== 'object') return null;
    const speech = typeof data.plan.speech === 'string' ? data.plan.speech.trim() : '';
    const actions = safePlanActions(data.plan.actions);
    if (!speech && actions.length === 0) return null;
    return { speech, actions };
  } catch {
    return null;
  }
}
