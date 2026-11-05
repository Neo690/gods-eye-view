import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  handleAgentPlan,
  planRelayStatus,
  AGENT_PLAN_UPSTREAM_TIMEOUT_MS,
} from './agent-plan.js';
import { OPENAI_AGENT_PLAN_MODEL_DEFAULT } from './constants.js';

/**
 * `/api/openai/agent-plan` — the Sentinel planning relay on OpenAI, the
 * primary rung of the planner ladder the Gemini relay falls back to.
 *
 * Contract under test (mirrors the Gemini relay it shares the safeguards
 * with): POST-only, a missing key is a bounded keyless 503
 * `{plan: null, error: 'not-configured'}`, the per-IP budget guards the real
 * work, a malformed body is a 400, and the relay answers `planRelayStatus`:
 * a shapable plan is 200, an upstream 2xx whose text never shapes is a fixed
 * 502, any other upstream status passes through, and anything that throws
 * (oversized body, socket failure, the 30s upstream timeout) degrades to the
 * same fixed 502. The credential never leaves Node.
 *
 * Ordering note: `openAiRateLimiter()` is built lazily on the first request
 * it guards and then cached, so the 429 test runs FIRST with
 * `GEV_RATELIMIT_OPENAI_PER_MIN=1` to pin the cap it is created with; every
 * later test uses its own client IP (the cached cap stays 1).
 */

/** Drive the handler the way a dev-server middleware call arrives, and
 *  resolve {status, headers, body} out of the fake response. */
async function call({
  method = 'POST',
  // A valid planning request by default; tests that pin validation pass
  // their own body. The 429 test runs first, so keep its body actionable.
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
  const pending = handleAgentPlan(req, res);
  req.end(method === 'POST' ? body : undefined);
  await pending;
  return { status: res.statusCode, headers: res.headers, body: res.body };
}

/** An /v1/responses answer carrying the plan in the model's JSON text. */
function responsesPayload(text, { status = 200 } = {}) {
  return new Response(JSON.stringify({ output_text: text }), { status });
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
  const savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { status, headers, body } = await call();
    assert.equal(status, 503);
    assert.deepEqual(body, { plan: null, error: 'not-configured' });
    assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(headers.get('cache-control'), 'no-store');
  } finally {
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  }
});

test('the relay allows one plan per client per minute and 429s the next', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const saved = { key: process.env.OPENAI_API_KEY, cap: process.env.GEV_RATELIMIT_OPENAI_PER_MIN };
  process.env.OPENAI_API_KEY = 'fixture-private-key';
  process.env.GEV_RATELIMIT_OPENAI_PER_MIN = '1';
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push({ url: String(url), options });
    return responsesPayload(PLAN_JSON);
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
    if (saved.key !== undefined) process.env.OPENAI_API_KEY = saved.key;
    else delete process.env.OPENAI_API_KEY;
    if (saved.cap !== undefined) process.env.GEV_RATELIMIT_OPENAI_PER_MIN = saved.cap;
    else delete process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
  }
});

test('non-POST methods are refused before any key or upstream work', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('method gate must not fetch');
  });
  const { status, body, headers } = await call({ method: 'GET', ip: '10.3.0.1' });
  assert.equal(status, 405);
  assert.deepEqual(body, { error: 'Method not allowed' });
  assert.equal(headers.get('content-type'), 'application/json');
});

test('a body without instructions is a 400 with nothing sent upstream', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', () => {
    throw Error('validation must precede upstream');
  });
  process.env.OPENAI_API_KEY = 'fixture-private-key';
  const bodies = [
    JSON.stringify({ input: {} }),
    JSON.stringify({ instructions: '   ' }),
    '{}',
  ];
  try {
    for (let i = 0; i < bodies.length; i++) {
      const { status, body: out } = await call({ body: bodies[i], ip: '10.4.0.' + (i + 1) });
      assert.equal(status, 400);
      assert.deepEqual(out, { error: 'Missing agent instructions' });
    }
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('a plan rides one /v1/responses round trip to the default nano planner, on a bounded wait', async (t) => {
  t.mock.method(console, 'warn', () => {});
  process.env.OPENAI_API_KEY = 'fixture-private-key';
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push({ url: String(url), options });
    return responsesPayload(PLAN_JSON);
  });
  try {
    const { status, body } = await call({ ip: '10.5.0.1' });
    assert.equal(status, 200);
    assert.equal(calls.length, 1);
    const { url, options } = calls[0];
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer fixture-private-key');
    const upstream = JSON.parse(options.body);
    assert.equal(upstream.model, OPENAI_AGENT_PLAN_MODEL_DEFAULT);
    assert.equal(upstream.reasoning.effort, 'low');
    assert.equal(upstream.max_output_tokens, 700);
    // The relay forwards the planner's built instructions verbatim (the
    // Sentinel/hints wording lives in the callers, not here).
    assert.equal(upstream.instructions, 'watch the layers');
    // Same safeguard as the Gemini fallback: the upstream wait is explicitly
    // bounded by the timeout both relays share, not left open-ended.
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(AGENT_PLAN_UPSTREAM_TIMEOUT_MS, 30_000);
    // The plan arrives shaped for the planner: speech plus trimmed actions.
    assert.deepEqual(body.plan, {
      speech: 'Zooming on the Great Lakes.',
      actions: [
        { action: 'zoom_to_globe', args: { lat: 45, lon: -84 } },
        { action: 'set_layer_visibility', args: { layerId: 'cctv', visible: false } },
      ],
    });
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('OPENAI_AGENT_PLAN_MODEL overrides the default nano planner', async (t) => {
  t.mock.method(console, 'warn', () => {});
  process.env.OPENAI_API_KEY = 'fixture-private-key';
  process.env.OPENAI_AGENT_PLAN_MODEL = 'gpt-99-tiny';
  const calls = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    calls.push({ url: String(url), options });
    return responsesPayload(PLAN_JSON);
  });
  try {
    const { status } = await call({ ip: '10.6.0.1' });
    assert.equal(status, 200);
    const upstream = JSON.parse(calls[0].options.body);
    assert.equal(upstream.model, 'gpt-99-tiny');
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_AGENT_PLAN_MODEL;
  }
});

test('a refused key surfaces as status passthrough with plan null', async (t) => {
  t.mock.method(console, 'warn', () => {});
  process.env.OPENAI_API_KEY = 'fixture-private-key';
  t.mock.method(globalThis, 'fetch', () => responsesPayload('{}', { status: 401 }));
  try {
    const { status, body, headers } = await call({ ip: '10.7.0.1' });
    assert.equal(status, 401);
    assert.deepEqual(body, { plan: null });
    assert.equal(headers.get('cache-control'), 'no-store');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('an upstream 200 whose text never shapes into a plan is a 502', async (t) => {
  t.mock.method(console, 'warn', () => {});
  process.env.OPENAI_API_KEY = 'fixture-private-key';
  t.mock.method(globalThis, 'fetch', () => responsesPayload('Sorry, I have no plan for you.'));
  try {
    const { status, body } = await call({ ip: '10.8.0.1' });
    assert.equal(status, 502);
    assert.deepEqual(body, { plan: null });
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('any handler failure — oversized body or throw — degrades to the fixed 502', async (t) => {
  t.mock.method(console, 'warn', () => {});
  process.env.OPENAI_API_KEY = 'fixture-private-key';
  try {
    // 512 KiB cap: one byte more fails the read and hits the catch.
    const huge = { instructions: 'x', input: { blob: 'b'.repeat(512 * 1024) } };
    const { status, body } = await call({ body: JSON.stringify(huge), ip: '10.9.0.1' });
    assert.equal(status, 502);
    assert.deepEqual(body, { error: 'Agent plan request failed' });
    // A hung upstream (the bounded wait fires) or a socket failure is the
    // same bounded failure — the fetch rethrows and the catch answers.
    t.mock.method(globalThis, 'fetch', () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const thrown = await call({ body: JSON.stringify({ instructions: 'watch' }), ip: '10.9.0.2' });
    assert.equal(thrown.status, 502);
    assert.deepEqual(thrown.body, { error: 'Agent plan request failed' });
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('planRelayStatus is the shared classification both planning relays run', () => {
  // A shapable plan wins outright.
  assert.equal(planRelayStatus({ speech: 'x' }, { ok: true, status: 200 }), 200);
  // An upstream success that never shapes is the relay's own 502.
  assert.equal(planRelayStatus(null, { ok: true, status: 200 }), 502);
  // Any other upstream status passes through — including the 429 that must
  // end the planner ladder instead of falling through.
  assert.equal(planRelayStatus(null, { ok: false, status: 429 }), 429);
  assert.equal(planRelayStatus(null, { ok: false, status: 401 }), 401);
  // A statusless upstream failure is still a bounded 502.
  assert.equal(planRelayStatus(null, { ok: false, status: 0 }), 502);
});
