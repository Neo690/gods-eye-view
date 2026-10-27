/**
 * Edge API for the standalone APK.
 *
 * The bundled build fetches `/api/*` from its own origin; in a WebView that is
 * the asset store, so every live layer answered HTTP 404. The Android shell
 * replays those calls against this Worker (see
 * `android/app/src/main/java/com/godseye/view/ApiForwarder.java`), which owns
 * the job the Vite middleware does: talk to the public feeds that send no CORS
 * headers, cache them, and hand the page the shape it already parses.
 *
 * Only GET/HEAD are served, because `WebResourceRequest` exposes no body.
 *
 * Routes
 *   GET /api/health                        route list + cache size
 *   GET /api/celestrak/{group}             CelesTrak GP/TLE text (6 h cache)
 *   GET /api/flights?lat=&lon=             OpenSky state vectors (10 s cache,
 *                                          250 nm adsb.lol snapshot on failure)
 *   GET /api/flights/track?icao24={hex}    OpenSky track for one aircraft
 *   GET /api/launches                      Launch Library 2 recent launches
 *   GET /api/tomtom/status                 {hasKey, dailyCount, budget, date}
 *   GET /api/tomtom/flow/{z}/{x}/{y}.pbf   TomTom flow tile (needs a key)
 *
 * Anything else answers 404 `{error: 'not_proxied'}`, which the page can tell
 * apart from "no server at all".
 */

const CELESTRAK_TTL_MS = 6 * 3600_000;
const FLIGHTS_TTL_MS = 10_000;
const TRACK_TTL_MS = 60_000;
const LAUNCHES_TTL_MS = 15 * 60_000;
const TOMTOM_TILE_TTL_MS = 120_000;
/** TomTom's free allowance is monthly; this matches the Node proxy's day cap. */
const TOMTOM_DAILY_BUDGET = 6000;

const USER_AGENT =
  'gods-eye-view-edge-api/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

const ROUTES = [
  '/api/health',
  '/api/celestrak/{group}',
  '/api/flights',
  '/api/flights/track?icao24={hex}',
  '/api/launches',
  '/api/tomtom/status',
  '/api/tomtom/flow/{z}/{x}/{y}.pbf',
];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'accept, content-type',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
};

/** Isolate-local cache: a Cache API eviction must not cost us the body. */
const memory = new Map();

function remember(key, entry) {
  if (memory.size > 64) memory.delete(memory.keys().next().value);
  memory.set(key, entry);
  return entry;
}

/** Cache API first (survives isolate recycling), memory second. */
async function readCache(key) {
  const local = memory.get(key);
  if (local) return local;
  try {
    const hit = await caches.default.match(`https://edge-api.internal/${key}`);
    if (!hit) return null;
    const type = hit.headers.get('x-edge-type') || 'application/json';
    const binary = hit.headers.get('x-edge-binary') === '1';
    const entry = {
      at: Number(hit.headers.get('x-edge-at') || 0) || 0,
      status: hit.status,
      type,
      body: binary ? await hit.arrayBuffer() : await hit.text(),
      binary,
    };
    if (!entry.at) return null;
    return remember(key, entry);
  } catch {
    return null;
  }
}

async function writeCache(key, entry) {
  remember(key, entry);
  try {
    await caches.default.put(
      new Request(`https://edge-api.internal/${key}`),
      new Response(entry.body, {
        headers: {
          'content-type': entry.type,
          'x-edge-at': String(entry.at),
          'x-edge-type': entry.type,
          'x-edge-binary': entry.binary ? '1' : '0',
        },
      }),
    );
  } catch {
    /* no Cache API (local harness, isolated runtime) — memory is enough */
  }
}

/**
 * Serve `key` from cache while fresh, otherwise load it once. `staleOnError`
 * keeps the last good body when the upstream fails, the way every other cache
 * in this repository does: a stale snapshot beats a dead layer.
 */
async function cached(key, ttlMs, load, { staleOnError = false } = {}) {
  const entry = await readCache(key);
  const now = Date.now();
  if (entry && now - entry.at < ttlMs) return { ...entry, cache: 'HIT' };
  try {
    const fresh = await load();
    const stored = { at: now, binary: false, ...fresh };
    await writeCache(key, stored);
    return { ...stored, cache: 'MISS' };
  } catch (error) {
    if (staleOnError && entry) return { ...entry, cache: 'STALE', error };
    throw error;
  }
}

function withHeaders(response, extra) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries({ ...CORS, ...extra })) {
    if (value != null) out.headers.set(name, String(value));
  }
  return out;
}

function json(status, body, headers = {}) {
  return withHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
    headers,
  );
}

function text(status, body, headers = {}) {
  return withHeaders(
    new Response(body, {
      status,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    }),
    headers,
  );
}

async function upstream(url, { headers = {}, timeoutMs = 20_000 } = {}) {
  return fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': USER_AGENT, ...headers },
  });
}

/* ── CelesTrak ──────────────────────────────────────────────────────────── */

function celestrakUrl(group) {
  const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
  url.searchParams.set('GROUP', group);
  url.searchParams.set('FORMAT', 'tle');
  return url;
}

async function serveCelestrak(group) {
  if (!/^[a-z0-9-]{1,40}$/i.test(group)) return text(400, 'invalid group');
  const entry = await cached(
    `celestrak:${group}`,
    CELESTRAK_TTL_MS,
    async () => {
      const response = await upstream(celestrakUrl(group));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      // CelesTrak answers 200 with an error page: no TLE lines means failure.
      if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
      return { status: 200, type: 'text/plain; charset=utf-8', body };
    },
    { staleOnError: true },
  );
  return text(entry.status, entry.body, { 'x-tle-cache': entry.cache });
}

/* ── OpenSky, with the bounded regional fallback ─────────────────────────── */

/** Anonymous states/all costs 4 credits; the 10 s cache bounds the damage. */
const OPENSKY_STATES = 'https://opensky-network.org/api/states/all?extended=1';

const FLIGHT_HEADERS = {
  'x-feed-source': 'OpenSky Network',
  'x-flight-source': 'OpenSky Network',
};

/**
 * Map readsb aircraft to OpenSky state vectors, the order
 * `normalizeOpenSkyAircraft` reads: icao24, callsign, origin country, position
 * time, last contact, longitude, latitude, baro altitude, on ground, velocity,
 * true track, vertical rate, sensors, geo altitude, squawk, spi, source,
 * category.
 */
function readsbStates(ac, nowMs) {
  const snapshotS = Math.floor(nowMs / 1000);
  return ac.map((row) => {
    const seen = Number.isFinite(row.seen_pos) ? row.seen_pos : row.seen;
    const contact = Number.isFinite(row.seen) ? row.seen : null;
    return [
      String(row.hex || '').toLowerCase(),
      String(row.flight || '').trim(),
      '',
      Number.isFinite(seen) ? snapshotS - seen : null,
      contact == null ? null : snapshotS - contact,
      Number.isFinite(row.lon) ? row.lon : null,
      Number.isFinite(row.lat) ? row.lat : null,
      row.alt_baro === 'ground'
        ? 0
        : Number.isFinite(row.alt_baro)
          ? row.alt_baro * 0.3048
          : null,
      row.alt_baro === 'ground',
      Number.isFinite(row.gs) ? row.gs * 0.514444 : null,
      Number.isFinite(row.track) ? row.track : null,
      Number.isFinite(row.baro_rate) ? row.baro_rate * 0.00508 : null,
      null,
      Number.isFinite(row.alt_geom) ? row.alt_geom * 0.3048 : null,
      row.squawk || null,
      false,
      1,
      // readsb reports "A3" style codes; OpenSky uses the numeric class.
      /^[AB]\d$/.test(String(row.category || ''))
        ? Number.parseInt(String(row.category).slice(1), 10)
        : null,
    ];
  });
}

/** 250 nm around the view anchor, the same radius the Node proxy uses. */
async function adsbLolFallback(lat, lon) {
  const response = await upstream(
    `https://api.adsb.lol/v2/lat/${lat.toFixed(2)}/lon/${lon.toFixed(2)}/dist/250`,
    { headers: { accept: 'application/json' }, timeoutMs: 12_000 },
  );
  if (!response.ok) throw new Error(`adsb.lol HTTP ${response.status}`);
  const payload = await response.json();
  const ac = Array.isArray(payload?.ac) ? payload.ac : [];
  return {
    status: 200,
    type: 'application/json; charset=utf-8',
    body: JSON.stringify({
      time: Math.floor(Date.now() / 1000),
      states: readsbStates(ac, Date.now()),
    }),
    source: 'adsb.lol',
    coverage: '250 nm point snapshot',
    cache: 'FALLBACK',
  };
}

async function serveFlights(url) {
  const lat = Number.parseFloat(url.searchParams.get('lat'));
  const lon = Number.parseFloat(url.searchParams.get('lon'));
  const anchor =
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90
      ? { lat, lon }
      : null;

  try {
    const entry = await cached(
      'opensky:states',
      FLIGHTS_TTL_MS,
      async () => {
        const response = await upstream(OPENSKY_STATES, {
          headers: { accept: 'application/json' },
        });
        const body = await response.text();
        if (!response.ok) throw new Error(`OpenSky HTTP ${response.status}`);
        JSON.parse(body); // a truncated body must not enter the cache
        return { status: 200, type: 'application/json; charset=utf-8', body };
      },
      { staleOnError: true },
    );
    return withHeaders(
      new Response(entry.body, {
        status: entry.status,
        headers: { 'content-type': entry.type },
      }),
      {
        ...FLIGHT_HEADERS,
        'x-flight-coverage': 'worldwide upstream snapshot',
        'x-opensky-cache': entry.cache,
      },
    );
  } catch (error) {
    if (anchor) {
      try {
        const fallback = await adsbLolFallback(anchor.lat, anchor.lon);
        return withHeaders(
          new Response(fallback.body, {
            status: 200,
            headers: { 'content-type': fallback.type },
          }),
          {
            'x-flight-source': fallback.source,
            'x-feed-source': fallback.source,
            'x-flight-coverage': fallback.coverage,
            'x-opensky-cache': 'FALLBACK',
          },
        );
      } catch {
        /* fall through to the error below */
      }
    }
    return json(
      502,
      { error: 'flights_unavailable', detail: String(error?.message || error) },
      {
        ...FLIGHT_HEADERS,
        'x-flight-coverage': 'none',
        'x-opensky-cache': 'NONE',
      },
    );
  }
}

async function serveTrack(icao24) {
  const hex = String(icao24 || '').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return json(400, { error: 'invalid icao24' });
  const entry = await cached(
    `opensky:track:${hex}`,
    TRACK_TTL_MS,
    async () => {
      const response = await upstream(
        `https://opensky-network.org/api/tracks/all?icao24=${hex}&time=0`,
        { headers: { accept: 'application/json' } },
      );
      const body = await response.text();
      if (!response.ok) throw new Error(`OpenSky HTTP ${response.status}`);
      JSON.parse(body);
      return { status: 200, type: 'application/json; charset=utf-8', body };
    },
    { staleOnError: true },
  );
  return withHeaders(
    new Response(entry.body, {
      status: entry.status,
      headers: { 'content-type': entry.type },
    }),
    { 'x-opensky-cache': entry.cache },
  );
}

/* ── Launch Library 2 ───────────────────────────────────────────────────── */

function launchesUrl(now = Date.now()) {
  const start = new Date(now - 30 * 86_400_000);
  const end = new Date(now);
  const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
  url.searchParams.set('net__gte', start.toISOString());
  url.searchParams.set('net__lte', end.toISOString());
  url.searchParams.set('limit', '100');
  url.searchParams.set('mode', 'detailed');
  return url;
}

async function serveLaunches(env) {
  const token = String(env?.LL2_API_TOKEN || '').trim();
  const entry = await cached(
    'll2:recent',
    LAUNCHES_TTL_MS,
    async () => {
      const response = await upstream(launchesUrl(), {
        headers: {
          accept: 'application/json',
          ...(token ? { authorization: `Token ${token}` } : {}),
        },
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`LL2 HTTP ${response.status}`);
      JSON.parse(body);
      return { status: 200, type: 'application/json; charset=utf-8', body };
    },
    { staleOnError: true },
  );
  return withHeaders(
    new Response(entry.body, {
      status: entry.status,
      headers: { 'content-type': entry.type },
    }),
    { 'x-launches-cache': entry.cache },
  );
}

/* ── TomTom traffic flow ────────────────────────────────────────────────── */

function utcDayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function tomtomStatus(env) {
  const hasKey = Boolean(String(env?.TOMTOM_API_KEY || '').trim());
  return json(200, {
    hasKey,
    dailyCount: 0,
    budget: TOMTOM_DAILY_BUDGET,
    date: utcDayKey(),
  });
}

async function serveTomtomTile(env, tile) {
  const match = /^(\d{1,2})\/(\d+)\/(\d+)\.pbf$/.exec(tile);
  if (!match) return json(400, { error: 'invalid_tile' });
  const [, z, x, y] = match;
  if (Number(z) > 22) return json(400, { error: 'invalid_tile' });
  const key = String(env?.TOMTOM_API_KEY || '').trim();
  if (!key) return json(503, { error: 'no_key' });

  const entry = await cached(
    `tomtom:${z}/${x}/${y}`,
    TOMTOM_TILE_TTL_MS,
    async () => {
      const response = await upstream(
        `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.pbf?key=${encodeURIComponent(key)}`,
        { timeoutMs: 15_000 },
      );
      if (!response.ok) throw new Error(`TomTom HTTP ${response.status}`);
      return {
        status: 200,
        type: 'application/vnd.mapbox-vector-tile',
        body: await response.arrayBuffer(),
        binary: true,
      };
    },
    { staleOnError: true },
  );
  return withHeaders(
    new Response(entry.body, {
      status: entry.status,
      headers: { 'content-type': entry.type },
    }),
    { 'x-tomtom-cache': entry.cache },
  );
}

/* ── Router ─────────────────────────────────────────────────────────────── */

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/' || path === '/api/health') {
    return json(200, {
      ok: true,
      service: 'gods-eye-view edge-api',
      routes: ROUTES,
      cached: memory.size,
    });
  }

  if (path.startsWith('/api/celestrak/')) {
    return serveCelestrak(path.slice('/api/celestrak/'.length));
  }
  if (path === '/api/flights') return serveFlights(url);
  if (path === '/api/flights/track') {
    return serveTrack(url.searchParams.get('icao24'));
  }
  if (path === '/api/launches') return serveLaunches(env);
  if (path === '/api/tomtom/status') return tomtomStatus(env);
  if (path.startsWith('/api/tomtom/flow/')) {
    return serveTomtomTile(env, path.slice('/api/tomtom/flow/'.length));
  }

  return json(404, {
    error: 'not_proxied',
    path,
    hint: 'The edge proxy serves celestrak, flights, launches and tomtom; the other /api routes still need the full Node server.',
    routes: ROUTES,
  });
}

export default {
  async fetch(request, env = {}) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(405, { error: 'method_not_allowed' });
    }
    const response = await route(request, env);
    return request.method === 'HEAD'
      ? new Response(null, {
          status: response.status,
          headers: response.headers,
        })
      : response;
  },
};
