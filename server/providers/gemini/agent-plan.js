import { readRequestBody } from '../common/request.js';
import { makeCostRateLimiter, clientKey } from '../common/rate-limit.js';
import { parseAgentPlan } from '../openai/agent-plan.js';
import { GEMINI_AGENT_PLAN_MODEL_DEFAULT } from './config.js';

/** The agent relay never buffers more than this request body. */
const MAX_PLAN_REQUEST_BYTES = 512 * 1024;

/**
 * Sentinel planning on Gemini — the AUTOMATIC FALLBACK the planner rides when
 * the OpenAI relay is unusable (2026-11 pivot made it primary; it is the
 * fallback again, so its own budget never double-spends a throttled OpenAI
 * cycle). The same World-Packet planning loop, but as one generateContent
 * round-trip with responseMimeType application/json, so the model answers
 * with the plan envelope directly. The permanent credential — the one
 * registered through the key-setup panel — stays on Node; the browser only
 * sees the plan.
 */

// Built lazily on first request (like the OpenAI limiter): `.env` is applied
// to process.env later, at the plugin config hook, so reading it at import
// time would always see it unset. The shared GEV_RATELIMIT_GEMINI_PER_MIN
// budget already guards the voice token mint; the fallback planner rides the
// same cap.
let _geminiPlanRateLimiter;

function geminiPlanRateLimiter() {
  if (_geminiPlanRateLimiter === undefined)
    _geminiPlanRateLimiter = makeCostRateLimiter(
      process.env.GEV_RATELIMIT_GEMINI_PER_MIN,
      30,
    );
  return _geminiPlanRateLimiter;
}

/** Apply the per-IP limiter, writing a 429 when over the cap. */
function enforceRateLimit(limiter, req, res) {
  if (!limiter) return true; // explicit 0 opt-out — unthrottled
  if (limiter(clientKey(req))) return true;
  res.statusCode = 429;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Retry-After', '5');
  res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
  return false;
}

/** Pull the plain text back out of a generateContent payload. */
function extractResponseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((part) => typeof part?.text === 'string')
    .map((part) => part.text)
    .join('');
  return text.trim();
}

async function handleGeminiAgentPlan(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Same contract as the OpenAI relay: a missing key is a keyless answer,
    // not a 500 — the agent degrades locally (watchdog-only) instead of
    // retrying a dead endpoint.
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ plan: null, error: 'not-configured' }));
    return;
  }

  // Agent planning is one round-trip every few minutes; the voice token mint
  // rides the same budget, so the shared per-IP cap is plenty.
  if (!enforceRateLimit(geminiPlanRateLimiter(), req, res)) return;

  try {
    const body = await readRequestBody(req, MAX_PLAN_REQUEST_BYTES);
    const { instructions, input } = JSON.parse(body || '{}');
    if (typeof instructions !== 'string' || !instructions.trim()) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing agent instructions' }));
      return;
    }
    const model = String(
      process.env.GEMINI_AGENT_PLAN_MODEL || GEMINI_AGENT_PLAN_MODEL_DEFAULT,
    ).trim();
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instructions }] },
          contents: [
            {
              role: 'user',
              parts: [{ text: JSON.stringify(input ?? {}) }],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: 700,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const data = await response.json().catch(() => ({}));
    const plan = response.ok ? parseAgentPlan(extractResponseText(data)) : null;
    res.statusCode = plan ? 200 : response.ok ? 502 : response.status || 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!plan)
      console.warn(`[gemini-agent-plan] upstream HTTP ${response.status}`);
    res.end(JSON.stringify({ plan }));
  } catch {
    console.warn('[gemini-agent-plan] request failed');
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Agent plan request failed' }));
  }
}

export { handleGeminiAgentPlan };
