import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  HUD_SUMMARY_INSTRUCTIONS,
  HUD_SUMMARY_UNCONFIGURED_CODE,
  hudSummaryLayerContext,
  hudTelemetryProvenance,
  isHudSummaryUnconfigured,
  keylessHudSummaryResponse,
} from './hudSummaryResponse.js';
import { openAiRealtimeProxy } from '../vite.config.js';

const UNCONFIGURED_PAYLOAD = {
  configured: false,
  code: HUD_SUMMARY_UNCONFIGURED_CODE,
  error: null,
  summary: null,
};

function installOpenAiRoutes() {
  const routes = new Map();
  openAiRealtimeProxy().configureServer({
    middlewares: {
      use(path, handler) {
        routes.set(path, handler);
      },
    },
  });
  return routes;
}

function invokeRoute(
  handler,
  { method = 'GET', url = '/', remoteAddress = '127.0.0.1' } = {},
) {
  return new Promise((resolve, reject) => {
    const headers = new Map();
    const req = {
      method,
      url,
      headers: {},
      socket: { remoteAddress },
    };
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers.set(String(name).toLowerCase(), String(value));
      },
      end(body = '') {
        resolve({
          statusCode: this.statusCode,
          headers: Object.fromEntries(headers),
          body: body ? JSON.parse(String(body)) : null,
        });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('builds an HTTP-success capability response only for a blank key', () => {
  assert.deepEqual(keylessHudSummaryResponse(undefined), {
    statusCode: 200,
    payload: UNCONFIGURED_PAYLOAD,
  });
  assert.deepEqual(keylessHudSummaryResponse('  '), {
    statusCode: 200,
    payload: UNCONFIGURED_PAYLOAD,
  });
  assert.equal(keylessHudSummaryResponse('configured-key'), null);
});

test('recognizes only the exact deliberate no-key fallback response', () => {
  assert.equal(isHudSummaryUnconfigured(200, UNCONFIGURED_PAYLOAD), true);
  assert.equal(isHudSummaryUnconfigured(503, UNCONFIGURED_PAYLOAD), false);
  assert.equal(
    isHudSummaryUnconfigured(200, {
      ...UNCONFIGURED_PAYLOAD,
      error: 'provider failed',
    }),
    false,
  );
  assert.equal(
    isHudSummaryUnconfigured(200, {
      ...UNCONFIGURED_PAYLOAD,
      summary: 'Unexpected provider output',
    }),
    false,
  );
  assert.equal(
    isHudSummaryUnconfigured(200, {
      ...UNCONFIGURED_PAYLOAD,
      configured: true,
    }),
    false,
  );
  assert.equal(
    isHudSummaryUnconfigured(200, {
      ...UNCONFIGURED_PAYLOAD,
      unexpected: true,
    }),
    false,
  );
  assert.equal(
    isHudSummaryUnconfigured(200, {
      code: HUD_SUMMARY_UNCONFIGURED_CODE,
    }),
    false,
  );
});

test('does not hide real provider and HTTP failures', () => {
  assert.equal(
    isHudSummaryUnconfigured(502, {
      code: HUD_SUMMARY_UNCONFIGURED_CODE,
    }),
    false,
  );
  assert.equal(isHudSummaryUnconfigured(503, UNCONFIGURED_PAYLOAD), false);
  assert.equal(
    isHudSummaryUnconfigured(200, { error: 'provider failed' }),
    false,
  );
});

test('the installed keyless HUD route stays successful after the voice quota is exhausted', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  const previousLimit = process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
  process.env.OPENAI_API_KEY = '';
  process.env.GEMINI_API_KEY = '';
  process.env.GEV_RATELIMIT_OPENAI_PER_MIN = '1';
  try {
    const routes = installOpenAiRoutes();
    const token = routes.get('/api/realtime/token');
    const hud = routes.get('/api/openai/hud-summary');
    assert.equal(typeof token, 'function');
    assert.equal(typeof hud, 'function');

    const firstToken = await invokeRoute(token);
    const secondToken = await invokeRoute(token);
    assert.equal(firstToken.statusCode, 503);
    assert.deepEqual(firstToken.body, { error: 'OPENAI_API_KEY is not set' });
    assert.equal(secondToken.statusCode, 429);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await invokeRoute(hud, { method: 'POST' });
      assert.equal(response.statusCode, 200);
      assert.equal(
        response.headers['content-type'],
        'application/json; charset=utf-8',
      );
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.deepEqual(response.body, UNCONFIGURED_PAYLOAD);
    }
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiKey;
    if (previousLimit === undefined)
      delete process.env.GEV_RATELIMIT_OPENAI_PER_MIN;
    else process.env.GEV_RATELIMIT_OPENAI_PER_MIN = previousLimit;
  }
});

test('HUD summary context and telemetry tag carry chip-identical feed-state', () => {
  const now = 1_000_000;
  const layers = [
    {
      id: 'flights',
      name: 'Live Flights',
      enabled: true,
      stats: {
        stale: true,
        count: 12,
        lastUpdate: now - 240_000,
        source: 'OpenSky Network',
      },
    },
    {
      id: 'earthquakes',
      name: 'Earthquakes',
      enabled: false,
      stats: { count: 3, lastUpdate: now },
    },
  ];
  const context = hudSummaryLayerContext(layers, { now });
  assert.deepEqual(context.enabledLayerLabels, ['Live Flights']);
  assert.equal(context.enabledLayers[0].feedState, 'stale');
  assert.equal(context.feedProvenance.overall, 'stale');
  assert.deepEqual(hudTelemetryProvenance(layers, { now }), {
    state: 'stale',
    names: ['Live Flights'],
  });
  assert.equal(
    hudTelemetryProvenance(
      [
        {
          id: 'flights',
          name: 'Live Flights',
          enabled: true,
          stats: { count: 4, lastUpdate: now },
        },
      ],
      { now },
    ),
    null,
  );
});

test('HUD summary instructions require non-nominal feedState in the five words', () => {
  assert.match(
    HUD_SUMMARY_INSTRUCTIONS,
    /five words MUST include that feedState token/,
  );
  assert.match(
    HUD_SUMMARY_INSTRUCTIONS,
    /STALE, DEGRADED, FALLBACK, LOADING, or UNAVAILABLE/,
  );
  assert.match(HUD_SUMMARY_INSTRUCTIONS, /feedProvenance/);
});

test('the HUD proxy uses the shared provenance instructions', () => {
  const local = readFileSync(
    new URL('../server/providers/openai/hud-summary.js', import.meta.url),
    'utf8',
  );
  assert.match(local, /HUD_SUMMARY_INSTRUCTIONS/);
  assert.doesNotMatch(local, /enabled-layer text labels/);
});

test('AI summaries missing a non-nominal provenance token fall back deterministically', async () => {
  const { hudSummaryMatchesProvenance } =
    await import('./hudSummaryResponse.js');
  assert.equal(
    hudSummaryMatchesProvenance('Austin flights operating normally today', {
      overall: 'stale',
    }),
    false,
  );
  assert.equal(
    hudSummaryMatchesProvenance('Austin stale flights over downtown', {
      overall: 'stale',
    }),
    true,
  );
  assert.equal(
    hudSummaryMatchesProvenance('Austin flights operating normally today', {
      overall: 'nominal',
    }),
    true,
  );
});

test('enabled layers carry their own records as highlights', async () => {
  const { hudSummaryLayerContext } = await import('./hudSummaryResponse.js');
  const now = 1_000_000;
  const context = hudSummaryLayerContext(
    [
      {
        id: 'conflict-events',
        name: 'Conflict events (7d)',
        enabled: true,
        stats: { count: 6, lastUpdate: now, source: 'ACLED' },
        getRowControls: () => ({
          list: {
            items: [
              { lead: '23 killed', text: 'Battles · Ukraine' },
              { lead: '12 killed', text: 'Explosions · Sudan' },
              { lead: '4 killed', text: 'Battles · Mali' },
            ],
          },
        }),
      },
      {
        id: 'flights',
        name: 'Live Flights',
        enabled: false,
        stats: { count: 99, lastUpdate: now },
        getRowControls: () => ({
          list: { items: [{ lead: 'N123', text: 'FL350' }] },
        }),
      },
      {
        id: 'bare',
        name: 'No Card Layer',
        enabled: true,
        stats: { count: 0, lastUpdate: null },
      },
    ],
    { now },
  );
  assert.equal(context.enabledLayers[0].count, 6);
  assert.deepEqual(context.enabledLayers[0].highlights, [
    '23 killed · Battles · Ukraine',
    '12 killed · Explosions · Sudan',
  ]);
  // Disabled layers contribute nothing, and a layer without a card carries
  // no highlights key at all rather than an empty one.
  assert.equal(context.enabledLayerLabels.includes('Live Flights'), false);
  assert.equal('highlights' in context.enabledLayers[1], false);
});

test('a layer card that throws cannot break the summary context', async () => {
  const { hudSummaryLayerContext } = await import('./hudSummaryResponse.js');
  const context = hudSummaryLayerContext([
    {
      id: 'broken',
      name: 'Broken',
      enabled: true,
      stats: { count: 1, lastUpdate: 1 },
      getRowControls: () => {
        throw new Error('no card');
      },
    },
  ]);
  assert.equal(context.enabledLayers[0].count, 1);
  assert.equal('highlights' in context.enabledLayers[0], false);
});

test('the five-word contract forbids an invented zero', () => {
  assert.match(
    HUD_SUMMARY_INSTRUCTIONS,
    /count is above zero, the five words MUST state that count/,
  );
  assert.match(HUD_SUMMARY_INSTRUCTIONS, /Never write ZERO, NONE or NO/);
  assert.match(HUD_SUMMARY_INSTRUCTIONS, /highlights must never contradict/);
});

test('an AI line claiming zero is dropped when records exist', async () => {
  const { hudSummaryCountsHonest } = await import('./hudSummaryResponse.js');
  const populated = [{ count: 6 }, { count: 50 }];
  assert.equal(
    hudSummaryCountsHonest('ZERO CONFLICT EVENTS SEVEN DAYS', populated),
    false,
  );
  assert.equal(
    hudSummaryCountsHonest('NONE REPORTED TODAY ANYWHERE', populated),
    false,
  );
  assert.equal(
    hudSummaryCountsHonest('SIX CONFLICT EVENTS NOMINAL FEED', populated),
    true,
  );
  // One genuinely empty layer keeps a zero claim plausible.
  assert.equal(
    hudSummaryCountsHonest('ZERO CONFLICT EVENTS SEVEN DAYS', [
      { count: 6 },
      { count: 0 },
    ]),
    true,
  );
  // Nothing enabled: nothing to contradict.
  assert.equal(
    hudSummaryCountsHonest('ZERO CONFLICT EVENTS SEVEN DAYS', []),
    true,
  );
});

test('highlights reach the context through the manager lookup, not the row', async () => {
  const { hudSummaryLayerContext } = await import('./hudSummaryResponse.js');
  // Exactly what DataLayerManager.getAll() hands out: no methods on the row.
  const rows = [
    {
      id: 'conflict-events',
      name: 'Conflict events (7d)',
      source: 'ACLED',
      enabled: true,
      lifecycleState: 'on',
      stats: { count: 6, lastUpdate: 5000, source: 'ACLED' },
    },
  ];
  const cards = new Map([
    [
      'conflict-events',
      {
        list: {
          items: [
            { lead: '23 killed', text: 'Battles · Ukraine' },
            { lead: '12 killed', text: 'Explosions · Sudan' },
          ],
        },
      },
    ],
  ]);
  const withLookup = hudSummaryLayerContext(rows, {
    now: 6000,
    getRowControls: (id) => cards.get(id) ?? null,
  });
  assert.equal(withLookup.enabledLayers[0].count, 6);
  assert.deepEqual(withLookup.enabledLayers[0].highlights, [
    '23 killed · Battles · Ukraine',
    '12 killed · Explosions · Sudan',
  ]);

  // Without the lookup the row has nothing to offer: no invented highlights.
  const withoutLookup = hudSummaryLayerContext(rows, { now: 6000 });
  assert.equal('highlights' in withoutLookup.enabledLayers[0], false);
});

test('the manager lookup is what hud.js passes', () => {
  const source = readFileSync(new URL('./hud.js', import.meta.url), 'utf8');
  assert.match(source, /hudSummaryLayerContext\([\s\S]{0,240}?getRowControls/);
  assert.match(source, /module\?\.getRowControls\?\.\(\)/);
});
