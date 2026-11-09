import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  GEMINI_HUD_SUMMARY_MODEL_DEFAULT,
  handleHudSummary,
} from './hud-summary.js';

/** Set an env var for one test and put the old value back afterwards. */
function env(t, name, value) {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  });
}

/** Drive the route the way a dev-server middleware call arrives. */
function request(handler, { body = '{}', ip = '10.60.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    Object.assign(req, {
      method: 'POST',
      url: '/',
      headers: { host: 'localhost:4173', 'content-type': 'application/json' },
      socket: { remoteAddress: ip },
    });
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers[name.toLowerCase()] = value;
      },
      end(raw = '') {
        resolve({
          status: this.statusCode,
          headers,
          body: String(raw),
          json: () => JSON.parse(String(raw)),
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const CONTEXT = Object.freeze({
  placeLabels: ['Austin'],
  enabledLayerLabels: ['Flights'],
  feedProvenance: { overall: 'stale' },
});

test('a refused OpenAI key falls back to Gemini for the five-word summary', async (t) => {
  env(t, 'OPENAI_API_KEY', 'fixture-openai-secret');
  env(t, 'GEMINI_API_KEY', 'fixture-gemini-secret');
  env(t, 'GEV_RATELIMIT_OPENAI_PER_MIN', '0');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('api.openai.com'))
      return Response.json(
        { error: { message: 'fixture upstream quota exhausted' } },
        { status: 429 },
      );
    return Response.json({
      candidates: [
        {
          content: {
            parts: [{ text: 'Austin flights stale tonight here' }],
          },
        },
      ],
    });
  });
  t.mock.method(console, 'warn', () => {});

  const response = await request(handleHudSummary, {
    body: JSON.stringify(CONTEXT),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), {
    summary: 'Austin flights stale tonight here',
    error: null,
  });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.includes('fixture-openai-secret'), false);
  assert.equal(response.body.includes('fixture-gemini-secret'), false);
  assert.equal(response.body.includes('fixture upstream quota'), false);
  assert.equal(calls.length, 2);

  const gemini = calls[1];
  assert.equal(
    gemini.url,
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_HUD_SUMMARY_MODEL_DEFAULT}:generateContent`,
  );
  assert.equal(
    gemini.options.headers['x-goog-api-key'],
    'fixture-gemini-secret',
  );
  const upstream = JSON.parse(gemini.options.body);
  assert.match(upstream.systemInstruction.parts[0].text, /five words/);
  assert.deepEqual(upstream.contents, [
    { role: 'user', parts: [{ text: JSON.stringify(CONTEXT) }] },
  ]);
  assert.deepEqual(upstream.generationConfig, {
    maxOutputTokens: 100,
    temperature: 0,
  });
});

test('Gemini answers alone when OpenAI is not configured', async (t) => {
  env(t, 'OPENAI_API_KEY', undefined);
  env(t, 'GEMINI_API_KEY', 'fixture-gemini-secret');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return Response.json({
      candidates: [{ content: { parts: [{ text: 'Austin quiet tonight' }] } }],
    });
  });

  const response = await request(handleHudSummary, {
    ip: '10.60.0.2',
    body: JSON.stringify(CONTEXT),
  });
  assert.equal(response.status, 200);
  assert.equal(response.json().summary, 'Austin quiet tonight');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /generativelanguage\.googleapis\.com/);
});

test('both providers failing keeps a fixed error and no upstream detail', async (t) => {
  env(t, 'OPENAI_API_KEY', 'fixture-openai-secret');
  env(t, 'GEMINI_API_KEY', 'fixture-gemini-secret');
  t.mock.method(globalThis, 'fetch', async (url) => {
    const provider = String(url).includes('api.openai.com')
      ? 'OpenAI'
      : 'Gemini';
    return Response.json(
      { error: { message: `${provider} quota exhausted req_fixture` } },
      { status: 429 },
    );
  });
  t.mock.method(console, 'warn', () => {});

  const response = await request(handleHudSummary, {
    ip: '10.60.0.3',
    body: JSON.stringify(CONTEXT),
  });
  assert.equal(response.status, 429);
  assert.deepEqual(response.json(), {
    summary: null,
    error: 'HUD summary request failed',
  });
  assert.equal(response.body.includes('req_fixture'), false);
});

test('no provider at all stays a successful keyless answer', async (t) => {
  env(t, 'OPENAI_API_KEY', undefined);
  env(t, 'GEMINI_API_KEY', undefined);
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('the keyless route must not fetch');
  });

  const response = await request(handleHudSummary, {
    ip: '10.60.0.4',
    body: '',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), {
    configured: false,
    code: 'OPENAI_NOT_CONFIGURED',
    error: null,
    summary: null,
  });
});
