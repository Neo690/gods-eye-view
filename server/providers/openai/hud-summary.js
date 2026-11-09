import {
  HUD_SUMMARY_INSTRUCTIONS,
  keylessHudSummaryResponse,
} from '../../../src/hudSummaryResponse.js';
import { enforceRateLimit, openAiRateLimiter } from './rate-limit.js';
import { readRequestBody } from '../common/request.js';
import { OPENAI_HUD_SUMMARY_MODEL_DEFAULT } from './constants.js';

/** Cheap current flash-lite model for the HUD's five-word summary fallback. */
export const GEMINI_HUD_SUMMARY_MODEL_DEFAULT = 'gemini-3.1-flash-lite';

function extractOpenAiResponseText(data) {
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

function extractGeminiResponseText(data) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => typeof part?.text === 'string')
    .map((part) => part.text)
    .join(' ')
    .trim();
}

function toFiveWordHudSummary(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join(' ');
}

/** One model round-trip; the caller decides whether to fall back. */
async function summarizeWithOpenAi(apiKey, context) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model:
        process.env.OPENAI_HUD_SUMMARY_MODEL ||
        OPENAI_HUD_SUMMARY_MODEL_DEFAULT,
      instructions: HUD_SUMMARY_INSTRUCTIONS,
      input: JSON.stringify(context),
      reasoning: { effort: 'minimal' },
      max_output_tokens: 100,
    }),
  });
  const data = await response.json().catch(() => ({}));
  return {
    status: response.status || 502,
    summary: response.ok
      ? toFiveWordHudSummary(extractOpenAiResponseText(data))
      : null,
  };
}

/**
 * The second rung: the same five-word contract through Gemini's REST API.
 * Keep the credential in the `x-goog-api-key` header, not the URL, so it never
 * lands in a proxy access log.
 */
async function summarizeWithGemini(apiKey, context) {
  const configured = String(
    process.env.GEMINI_HUD_SUMMARY_MODEL || GEMINI_HUD_SUMMARY_MODEL_DEFAULT,
  )
    .trim()
    .replace(/^models\//, '');
  const model = /^gemini-[a-z0-9][a-z0-9.-]{0,119}$/.test(configured)
    ? configured
    : GEMINI_HUD_SUMMARY_MODEL_DEFAULT;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: HUD_SUMMARY_INSTRUCTIONS }] },
        contents: [
          { role: 'user', parts: [{ text: JSON.stringify(context) }] },
        ],
        generationConfig: { maxOutputTokens: 100, temperature: 0 },
      }),
    },
  );
  const data = await response.json().catch(() => ({}));
  return {
    status: response.status || 502,
    summary: response.ok
      ? toFiveWordHudSummary(extractGeminiResponseText(data))
      : null,
  };
}

function sendSummary(res, status, summary, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ summary: summary || null, error: error || null }));
}

async function handleHudSummary(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const openAiKey = String(process.env.OPENAI_API_KEY ?? '').trim();
  const geminiKey = String(process.env.GEMINI_API_KEY ?? '').trim();
  const keyless = keylessHudSummaryResponse(openAiKey || geminiKey);
  if (keyless) {
    res.statusCode = keyless.statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(keyless.payload));
    return;
  }

  // Per-IP throttle (GEV_RATELIMIT_OPENAI_PER_MIN). On by default; 0 disables.
  // Keyless HUD fallback has no provider cost and resolves above without
  // consuming a paid-endpoint quota slot.
  if (!enforceRateLimit(openAiRateLimiter(), req, res)) return;

  let context;
  try {
    const body = await readRequestBody(req, 64 * 1024);
    context = JSON.parse(body || '{}');
  } catch {
    console.warn('[hud-summary] request failed');
    sendSummary(res, 400, null, 'Invalid HUD summary request');
    return;
  }

  let openAiFailure = null;
  if (openAiKey) {
    try {
      const result = await summarizeWithOpenAi(openAiKey, context);
      if (result.summary) {
        sendSummary(res, 200, result.summary, null);
        return;
      }
      openAiFailure = result.status;
      console.warn(`[hud-summary] OpenAI upstream HTTP ${result.status}`);
    } catch {
      openAiFailure = 502;
      console.warn('[hud-summary] OpenAI request failed');
    }
  }

  if (geminiKey) {
    try {
      const result = await summarizeWithGemini(geminiKey, context);
      if (result.summary) {
        sendSummary(res, 200, result.summary, null);
        return;
      }
      console.warn(`[hud-summary] Gemini upstream HTTP ${result.status}`);
      sendSummary(res, result.status, null, 'HUD summary request failed');
      return;
    } catch {
      console.warn('[hud-summary] Gemini request failed');
      sendSummary(res, 502, null, 'HUD summary request failed');
      return;
    }
  }

  sendSummary(
    res,
    openAiFailure || 502,
    null,
    openAiKey
      ? 'OpenAI HUD summary request failed'
      : 'HUD summary request failed',
  );
}

export { handleHudSummary };
