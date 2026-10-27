# Edge API — the keyless `/api/*` routes as one Worker

The bundled console asks its own origin for `/api/*`; in the Android shell that
origin is the asset store, so the live layers used to answer `HTTP 404`. The
shell handles the keyless feeds itself (`android/.../LiveApi.java`), and this
Worker is the same surface hosted instead: one deployable file, no build step,
no secret, no database.

It is optional. Nothing here is needed for the APK to show satellites, flights
or launches.

## Routes

| Route                                  | Upstream                        | Cache                                                                              |
| -------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /api/health`                      | —                               | route list                                                                         |
| `GET /api/celestrak/{group}`           | CelesTrak GP/TLE text           | 6 h, stale on failure                                                              |
| `GET /api/flights`                     | OpenSky `states/all?extended=1` | 10 s; `&lat=&lon=` enables a 250 nm adsb.lol snapshot when OpenSky is rate limited |
| `GET /api/flights/track?icao24={hex6}` | OpenSky `tracks/all`            | 60 s                                                                               |
| `GET /api/launches`                    | Launch Library 2, last 30 days  | 15 min                                                                             |
| `GET /api/tomtom/status`               | —                               | `{hasKey, dailyCount, budget, date}`                                               |
| `GET /api/tomtom/flow/{z}/{x}/{y}.pbf` | TomTom flow tiles               | 120 s; `503 {error:"no_key"}` without `TOMTOM_API_KEY`                             |

Only `GET`/`HEAD` are served: `WebResourceRequest` exposes no request body, so
a POST cannot be replayed by the shell anyway. Unknown paths answer
`404 {error:"not_proxied"}` so the page can tell "not ported" apart from "no
server at all".

`caches.default` holds the bodies (a Cache API eviction falls back to the
isolate's memory copy), so a busy phone does not refetch CelesTrak every load
and does not spend OpenSky's anonymous credits.

## Deploy

Any Workers host works, because the module is a plain `fetch` handler:

```bash
npx wrangler deploy edge-api/index.js --name gev-edge-api \
  --compatibility-date 2025-06-01
```

Add `TOMTOM_API_KEY` as a Worker secret only if you want live traffic tiles;
without it the layer falls back to OSM roads, exactly as a keyless local server
does. `LL2_API_TOKEN` is optional and only lifts Launch Library's rate limit.

Then point the APK at it — the origin is a build input, not a code change:

```bash
GEV_API_BASE=https://gev-edge-api.<account>.workers.dev ./gradlew assembleRelease
```

or set the `GEV_API_BASE` repository variable for the `Android APK` workflow.
With an origin configured, `ApiForwarder` replays the page's `/api/*` calls
there and the in-app `LiveApi` steps aside.

## Contract

Each route mirrors its `server/providers` counterpart: same upstream URL, same
cache window, same headers the client already parses (`x-tle-cache`,
`x-opensky-cache`, `x-flight-source`, `x-flight-coverage`). The Android proxy
and this Worker should stay in step; a change to one belongs in the other.

## Not here

The routes that need a credential or a long-lived connection stay on the Node
server: TomTom tiles without a key, AISStream vessels, CCTV, Google places and
the AI summary.
