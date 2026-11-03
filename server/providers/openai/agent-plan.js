import { enforceRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { OPENAI_AGENT_PLAN_MODEL_DEFAULT } from './constants.js';

/** The agent relay never buffers more than this request body. */
const MAX_PLAN_REQUEST_BYTES = 512 * 1024;

/**
 * Extract the model's answer text from an /v1/responses payload (same shape
 * as the HUD summary handler reads).
 */
function extractResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

/**
 * Parse the model's JSON plan. The instructions ask for JSON only, but a
 * fenced block or prose padding is tolerated: the first {...} span that
 * parses wins, anything else is a non-actionable plan.
 */
export function parseAgentPlan(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const direct = safeParse(text);
  if (direct) return shapePlan(direct);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  const parsed = safeParse(text.slice(start, end + 1));
  return parsed ? shapePlan(parsed) : null;
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function shapePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const speech =
    typeof plan.speech === 'string' ? plan.speech.trim().slice(0, 400) : '';
  const actions = Array.isArray(plan.actions) ? plan.actions.slice(0, 3) : [];
  const normalized = actions
    .filter(
      (action) =>
        action &&
        typeof action === 'object' &&
        typeof action.action === 'string' &&
        action.action.trim(),
    )
    .map((action) => ({
      action: action.action.trim(),
      args:
        action.args && typeof action.args === 'object' ? action.args : {},
    }));
  if (!speech && normalized.length === 0) return null;
  return { speech, actions: normalized };
}

async function handleAgentPlan(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Same contract as the HUD summary: a missing key is a keyless answer, not
    // a 500 — the agent degrades locally instead of retrying a dead endpoint.
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ plan: null, error: 'not-configured' }));
    return;
  }

  // The agent plans on a cadence of minutes, not seconds, so the shared
  // per-IP budget is plenty; the HUD already spends 4/min of it.
  if (!enforceRateLimit(openAiRateLimiter(), req, res)) return;

  try {
    const body = await readRequestBody(req, MAX_PLAN_REQUEST_BYTES);
    const { instructions, input } = JSON.parse(body || '{}');
    if (typeof instructions !== 'string' || !instructions.trim()) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing agent instructions' }));
      return;
    }
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_AGENT_PLAN_MODEL || OPENAI_AGENT_PLAN_MODEL_DEFAULT,
        instructions,
        input: JSON.stringify(input ?? {}),
        reasoning: { effort: 'low' },
        max_output_tokens: 700,
      }),
    });
    const data = await response.json().catch(() => ({}));
    const plan = response.ok
      ? parseAgentPlan(extractResponseText(data))
      : null;
    res.statusCode = plan ? 200 : response.ok ? 502 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!plan) console.warn(`[agent-plan] upstream HTTP ${response.status}`);
    res.end(JSON.stringify({ plan }));
  } catch {
    console.warn('[agent-plan] request failed');
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Agent plan request failed' }));
  }
}

export { handleAgentPlan };
