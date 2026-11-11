// server/providers/conflicts.test.mjs
// ACLED's OAuth URLs, the password-grant body, and the no-credential answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACLED_CLIENT_ID,
  ACLED_LIMIT,
  ACLED_TOKEN_URL,
  ACLED_UPSTREAM_URL,
  CONFLICTS_ROUTE,
  buildAcledUrl,
  buildTokenBody,
  conflictWindow,
  conflictsFailure,
  createConflictsHandler,
} from './conflicts.js';

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk;
    },
  };
}

test('conflict window is the trailing N days, inclusive of today', () => {
  const now = Date.parse('2026-11-11T18:00:00Z');
  assert.deepEqual(conflictWindow(now), {
    start: '2026-11-04',
    end: '2026-11-11',
  });
  assert.deepEqual(conflictWindow(now, 1), {
    start: '2026-11-10',
    end: '2026-11-11',
  });
});

test('the data url targets the post-2025 endpoint, with no credential in it', () => {
  const url = new URL(
    buildAcledUrl({ start: '2026-11-04', end: '2026-11-11' }),
  );
  assert.equal(url.origin, 'https://acleddata.com');
  assert.equal(url.pathname, '/api/acled/read');
  assert.equal(url.origin + url.pathname, ACLED_UPSTREAM_URL);
  assert.equal(url.searchParams.get('key'), null);
  assert.equal(url.searchParams.get('email'), null);
  assert.equal(url.searchParams.get('event_date'), '2026-11-04|2026-11-11');
  assert.equal(url.searchParams.get('event_date_where'), 'BETWEEN');
  assert.equal(url.searchParams.get('limit'), String(ACLED_LIMIT));
  assert.match(url.searchParams.get('fields'), /fatalities/);
});

test('the token request is the documented password grant', () => {
  const body = new URLSearchParams(
    buildTokenBody({ email: 'a@b.test', password: 'se cret&' }),
  );
  assert.equal(body.get('username'), 'a@b.test');
  assert.equal(body.get('password'), 'se cret&');
  assert.equal(body.get('grant_type'), 'password');
  assert.equal(body.get('client_id'), ACLED_CLIENT_ID);
  assert.equal(body.get('scope'), 'authenticated');
  assert.equal(new URL(ACLED_TOKEN_URL).pathname, '/oauth/token');
});

test('without credentials the route says no_key and never touches the network', async () => {
  let called = false;
  const { handle } = createConflictsHandler({
    acledEmail: undefined,
    acledPassword: undefined,
    fetchImpl: async () => {
      called = true;
      throw new Error('must not be called');
    },
  });
  const response = fakeResponse();
  await handle({ method: 'GET' }, response);
  assert.equal(called, false);
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error, 'no_key');
});

test('rejects anything but GET and HEAD', async () => {
  const { handle } = createConflictsHandler({
    acledEmail: 'a@b.test',
    acledPassword: 'x',
  });
  const response = fakeResponse();
  await handle({ method: 'POST' }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, 'GET, HEAD');
});

test('routes and failure payloads stay stable', () => {
  assert.equal(CONFLICTS_ROUTE, '/api/conflicts');
  assert.deepEqual(conflictsFailure('upstream', { generatedAt: 1 }), {
    ok: false,
    provider: null,
    error: 'upstream',
    generatedAt: 1,
  });
});

test('credentials added to process.env after construction are honoured', async () => {
  let calls = 0;
  const { handle } = createConflictsHandler({
    logger: { warn() {} },
    fetchImpl: async () => {
      calls += 1;
      throw new Error('offline');
    },
  });
  // Vite writes .env into process.env after this module is evaluated: the
  // handler must see credentials that did not exist when it was built.
  process.env.ACLED_EMAIL = 'late@example.test';
  process.env.ACLED_PASSWORD = 'late-secret';
  try {
    const response = fakeResponse();
    await handle({ method: 'GET' }, response);
    assert.equal(calls, 1, 'the proxy never reached the network');
    assert.equal(response.statusCode, 503);
    assert.equal(JSON.parse(response.body).error, 'upstream');
  } finally {
    delete process.env.ACLED_EMAIL;
    delete process.env.ACLED_PASSWORD;
  }
});
