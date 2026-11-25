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
  isConflictRoute,
  probeAcledCredentials,
  wantsFreshConflictRead,
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

function probeResponse(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload),
  };
}

test('the ACLED probe reads the saved pair, then one row, without throwing', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === ACLED_TOKEN_URL)
      return probeResponse(200, {
        access_token: 'bearer-fixture',
        expires_in: 3600,
      });
    return probeResponse(200, { data: [] });
  };
  assert.deepEqual(
    await probeAcledCredentials({
      email: 'analyst@example.test',
      password: 'test-only-password',
      fetchImpl,
    }),
    { status: 200 },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, ACLED_TOKEN_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(
    new URLSearchParams(calls[0].init.body).get('username'),
    'analyst@example.test',
  );
  const data = new URL(calls[1].url);
  assert.equal(data.searchParams.get('limit'), '1');
  assert.equal(data.searchParams.get('email'), null);
  assert.equal(data.searchParams.get('key'), null);
  assert.equal(calls[1].init.headers.authorization, 'Bearer bearer-fixture');
});

test('the ACLED probe separates a refused login from an account without API access', async () => {
  const tokenRefused = await probeAcledCredentials({
    email: 'a@b.test',
    password: 'x',
    fetchImpl: async () => probeResponse(401, { error: 'invalid_grant' }),
  });
  assert.deepEqual(tokenRefused, { status: 401 });

  const noAccess = await probeAcledCredentials({
    email: 'a@b.test',
    password: 'x',
    fetchImpl: async (url) =>
      url === ACLED_TOKEN_URL
        ? probeResponse(200, { access_token: 'bearer-fixture' })
        : probeResponse(403, { error: 'forbidden' }),
  });
  assert.deepEqual(noAccess, { status: 403 });
});

test('the ACLED probe answers 409 without both credentials and null when unreachable', async () => {
  let called = false;
  assert.deepEqual(
    await probeAcledCredentials({
      email: 'a@b.test',
      password: '',
      fetchImpl: async () => {
        called = true;
      },
    }),
    { status: 409, code: 'no-credentials' },
  );
  assert.equal(called, false);
  assert.deepEqual(
    await probeAcledCredentials({
      email: 'a@b.test',
      password: 'x',
      fetchImpl: async () => {
        throw new TypeError('offline');
      },
    }),
    { status: null },
  );
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

test('the mounted route accepts a refresh query instead of passing it through', () => {
  assert.equal(isConflictRoute('/'), true);
  assert.equal(isConflictRoute('/?refresh=1'), true);
  assert.equal(isConflictRoute(CONFLICTS_ROUTE), true);
  assert.equal(isConflictRoute(`${CONFLICTS_ROUTE}?refresh=1`), true);
  assert.equal(isConflictRoute('/api/conflicts/other'), false);
  assert.equal(wantsFreshConflictRead('/?refresh=1'), true);
  assert.equal(wantsFreshConflictRead('/api/conflicts?refresh=1'), true);
  assert.equal(wantsFreshConflictRead('/api/conflicts'), false);
  assert.equal(wantsFreshConflictRead('/api/conflicts?refresh=true'), false);
});

test('a manual refresh bypasses the cache and replaces the old bearer token', async () => {
  let clock = Date.parse('2026-11-20T12:00:00Z');
  let tokenCalls = 0;
  let dataCalls = 0;
  const fetchImpl = async (url) => {
    if (url === ACLED_TOKEN_URL) {
      tokenCalls += 1;
      return probeResponse(200, {
        access_token: `token-${tokenCalls}`,
        expires_in: 3600,
      });
    }
    dataCalls += 1;
    return probeResponse(200, { data: [] });
  };
  const { handle } = createConflictsHandler({
    acledEmail: 'a@b.test',
    acledPassword: 'x',
    fetchImpl,
    now: () => clock,
    logger: { warn() {} },
  });

  const first = fakeResponse();
  await handle({ method: 'GET', url: '/?refresh=0' }, first);
  assert.equal(first.statusCode, 200);
  assert.equal(tokenCalls, 1);
  assert.equal(dataCalls, 1);
  const firstBody = JSON.parse(first.body);
  assert.equal(firstBody.generatedAt, clock);

  // Inside the ten-minute window the cached snapshot answers: no token and no
  // data request reach ACLED.
  clock += 60_000;
  const cached = fakeResponse();
  await handle({ method: 'GET', url: '/' }, cached);
  assert.equal(tokenCalls, 1);
  assert.equal(dataCalls, 1);
  assert.equal(JSON.parse(cached.body).generatedAt, firstBody.generatedAt);

  // A manual read must reach upstream even inside that window, and must not
  // reuse a token minted for the credentials that were just replaced.
  const forced = fakeResponse();
  await handle({ method: 'GET', url: '/?refresh=1' }, forced);
  assert.equal(tokenCalls, 2);
  assert.equal(dataCalls, 2);
  assert.equal(JSON.parse(forced.body).generatedAt, clock);
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
