import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { handleGeminiAgentPlan } from './agent-plan.js';
import { GEMINI_AGENT_PLAN_MODEL_DEFAULT } from './config.js';

/**
 * `/api/gemini/agent-plan` — the Sentinel planning relay on Gemini.
 *
 * Contract under test (mirrors the OpenAI relay the planner left): POST-only,
 * a missing key is a bounded keyless 503 `{plan: null, error: 'not-configured'}`,
 * the per-IP budget guards the real work, a malformed body is a 400, upstream
 * failures surface as `{plan: null}` with the upstream status (or a fixed 502),
 * and anything that throws (oversized body, socket failure) degrades to the
 * same fixed 502. The permanent key never leaves Node.
 *
 * Ordering note: `geminiPlanRateLimiter()` is built lazily on the first
 * request it guards and then cached, so the 429 test runs FIRST with
 * `GEV_RATELIMIT_GEMINI_PER_MIN=1` to pin the cap it is created with; every
 * later test uses its own client IP and an explicit `0` is unthrottled anyway
 * only for requests… the cached cap stays 1, hence the distinct IPs.
 */

/** Drive the handler the way a dev-server middleware call arrives, and
 *  resolve {status, headers, body} out of the fake response. */
async function call({
  method = 'POST',
  // A valid planning request by default; tests that pin validation pass their
  // own body. The 429 test runs first, so keep its body actionable.
  body = JSON.stringify({ instructions: 'watch the layers', input: {} }),
  ip = '10.1.0.1',
} = {}) {
  const req = Object.assign(new PassThrough(), {
    method,
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: ip },
  });
  const res = Object.assign(new EventEmitter(), {
    headers: new Map(),
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), value);
    },
    end(raw) {
      this.writableEnded = true;
      this.body = raw ? JSON.parse(raw) : undefined;
    },
  });
  const pending = handleGeminiAgentPlan(req, res);
  req.end(method === 'POST' ? body : undefined);
  await pending;
  return { status: res.statusCode, headers: res.headers, body: res.body };
}

/** A Gemini generateContent answer carrying the plan as bare JSON text. */
function generateContentResponse(text, { status = 200 } = {}) {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
    { status },
  );
}

const PLAN_JSON = JSON.stringify({
  speech: 'Zooming on the Great Lakes.',
  actions: [
    { action: 'zoom_to_globe', args: { lat: 45, lon: -84 } },
    { action: 'set_layer_visibility', args: { layerId: 'cctv', visible: false } },
  ],
});

test('the relay answers keyless 503 not-configured and never touches upstream', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('keyless relay must not fetch');
  });
  const savedKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const { status, headers, body } = await call();
    assert.equal(status, 503);
    assert.deepEqual(body, { plan: null, error: 'not-configured' });
    assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(headers.get('cache-control'), 'no-store');
  } finally {
    if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
  }
});

test('the relay allows one plan per client per minute and 429s the next', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const saved = { key: process.env.GEMINI_API_KEY, cap: process.env.GEV_RATELIMIT_GEMINI_PER_MIN };
  process.env.GEMINI_API_KEY = 'fixture-private-key';
  process.env.GEV_RATELIMIT_GEMINI_PER_MIN = '1';
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push({ url: String(url), options });
    return generateContentResponse(PLAN_JSON);
  });
  try {
    const first = await call({ ip: '10.2.0.7' });
    assert.equal(first.status, 200);
    assert.ok(first.body.plan);
    const second = await call({ ip: '10.2.0.7' });
    assert.equal(second.status, 429);
    assert.equal(second.body.error, 'Rate limit exceeded');
    assert.equal(second.headers.get('retry-after'), '5');
    assert.equal(calls.length, 1, 'the 429 never reaches upstream');
    // A different client is not punished for the first one's spend.
    const other = await call({ ip: '10.2.0.8' });
    assert.equal(other.status, 200);
  } finally {
    if (saved.key !== undefined) process.env.GEMINI_API_KEY = saved.key;
    else delete process.env.GEMINI_API_KEY;
    if (saved.cap !== undefined) process.env.GEV_RATELIMIT_GEMINI_PER_MIN = saved.cap;
    else delete process.env.GEV_RATELIMIT_GEMINI_PER_MIN;
  }
});

test('non-POST methods are refused before any key or upstream work', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('method gate must not fetch');
  });
  const { status, body, headers } = await call({ method: 'GET' });
  assert.equal(status, 405);
  assert.deepEqual(body, { error: 'Method not allowed' });
  assert.equal(headers.get('content-type'), 'application/json');
});

test('a body without instructions is a 400 with nothing sent upstream', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('validation must precede upstream');
  });
  // The limiter is already locked at 1/min by the 429 test, so give each
  // client its own IP to stay under its per-minute spend.
  process.env.GEMINI_API_KEY = 'fixture-private-key';
  const bodies = [
    JSON.stringify({ input: {} }),
    JSON.stringify({ instructions: '   ' }),
    '{}',
  ];
  try {
    for (let i = 0; i < bodies.length; i++) {
      const { status, body: out } = await call({ body: bodies[i], ip: '10.3.0.' + (i + 1) });
      assert.equal(status, 400);
      assert.deepEqual(out, { error: 'Missing agent instructions' });
    }
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

test('a plan rides one generateContent round trip to the default flash model', async (t) => {
  t.mock.method(console, 'warn', () => {});
  process.env.GEMINI_API_KEY = 'fixture-private-key';
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push({ url: String(url), options });
    return generateContentResponse(PLAN_JSON);
  });
  try {
    const { status, body } = await call({ ip: '10.4.0.1' });
    assert.equal(status, 200);
    assert.equal(calls.length, 1);
    const { url, options } = calls[0];
    assert.equal(
      url,
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_AGENT_PLAN_MODEL_DEFAULT}:generateContent`,
    );
    assert.equal(options.headers['x-goog-api-key'], 'fixture-private-key');
    const upstream = JSON.parse(options.body);
    assert.equal(upstream.generationConfig.responseMimeType, 'application/json');
    assert.equal(upstream.generationConfig.maxOutputTokens, 700);
    // The relay forwards the planner's built instructions verbatim (the
    // Sentinel/hints wording lives in buildAgentPlanRequest, not here).
    assert.equal(upstream.systemInstruction.parts[0].text, 'watch the layers');
    assert.equal(upstream.contents[0].role, 'user');
    // The plan arrives shaped for the planner: speech plus trimmed actions.
    assert.deepEqual(body, {
      plan: {
        speech: 'Zooming on the Great Lakes.',
        actions: [
          { action: 'zoom_to_globe', args: { lat: 45, lon: -84 } },
          { action: 'set_layer_visibility', args: { layerId: 'cctv', visible: false } },
        ],
      },
    });
    assert.equal(body.plan.actions.length, 2);
    assert.ok(!JSON.stringify(body).includes('fixture-private-key'));
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

test(`GEMINI_AGENT_PLAN_MODEL overrides the default flash model`, async (t) => {
  t.mock.method(console, 'warn', () => {});
  process.env.GEMINI_API_KEY = 'fixture-private-key';
  process.env.GEMINI_AGENT_PLAN_MODEL = 'gemini-3.8-flash-lite';
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push({ url: String(url), options });
    return generateContentResponse(PLAN_JSON);
  });
  try {
    const { status } = await call({ ip: '10.5.0.1' });
    assert.equal(status, 200);
    assert.match(calls[0].url, /models\/gemini-3\.8-flash-lite:generateContent/);
  } finally {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_AGENT_PLAN_MODEL;
  }
});

test('a keyless upstream refusal surfaces as status passthrough with plan null', async (t) => {
  t.mock.method(console, 'warn', () => {});
  process.env.GEMINI_API_KEY = 'fixture-private-key';
  t.mock.method(globalThis, 'fetch', () => Response.json({}, { status: 401 }));
  try {
    const { status, body, headers } = await call({ ip: '10.6.0.1' });
    assert.equal(status, 401);
    assert.deepEqual(body, { plan: null });
    assert.equal(headers.get('cache-control'), 'no-store');
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

test('an upstream 200 whose text never shapes into a plan is a 502', async (t) => {
  t.mock.method(console, 'warn', () => {});
  process.env.GEMINI_API_KEY = 'fixture-private-key';
  t.mock.method(globalThis, 'fetch', () => generateContentResponse('Sorry, I have no plan for you.'));
  try {
    const { status, body } = await call({ ip: '10.7.0.1' });
    assert.equal(status, 502);
    assert.deepEqual(body, { plan: null });
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

test('any handler failure — oversized body or throw — degrades to the fixed 502', async (t) => {
  t.mock.method(console, 'warn', () => {});
  process.env.GEMINI_API_KEY = 'fixture-private-key';
  try {
    // 512 KiB cap: one byte more fails the read and hits the catch.
    const huge = { instructions: 'x', input: { blob: 'b'.repeat(512 * 1024) } };
    const { status, body } = await call({ body: JSON.stringify(huge), ip: '10.8.0.1' });
    assert.equal(status, 502);
    assert.deepEqual(body, { error: 'Agent plan request failed' });
    // An upstream that throws mid-answer is the same bounded failure.
    t.mock.method(globalThis, 'fetch', () => {
      throw new Error('synthetic network failure');
    });
    const thrown = await call({ body: JSON.stringify({ instructions: 'watch' }), ip: '10.8.0.2' });
    assert.equal(thrown.status, 502);
    assert.deepEqual(thrown.body, { error: 'Agent plan request failed' });
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});
