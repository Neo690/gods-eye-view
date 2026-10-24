# God's Eye View — Android shell

A single-Activity WebView that runs the Vite build on a phone as a standalone
APK. Nothing on the Android side is a second implementation: the console is the
same bundle, served from `https://appassets.androidplatform.net/` out of
`app/src/main/assets/www`, which keeps ES modules, workers, `localStorage` and
`getUserMedia` on a real secure origin.

## Build and install

```bash
# from the repository root
npm run build
rm -rf android/app/src/main/assets/www/*
cp -r dist/* android/app/src/main/assets/www/

cd android
JAVA_HOME=/c/Android/jdk-17.0.20.1+1 ANDROID_HOME=C:/Android \
  ~/.gradle/wrapper/dists/gradle-8.14.3-all/*/gradle-8.14.3/bin/gradle \
  assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`android/local.properties` only needs `sdk.dir=<Android SDK>`.

The assets copy and the Gradle output are build artifacts: they are ignored by
git and must be regenerated after every `npm run build`.

A wrapper is checked in, so `./gradlew assembleRelease` works with no global
Gradle; it only needs `JAVA_HOME` on JDK 17 and `ANDROID_HOME`.

## Install from the phone, no computer

`.github/workflows/android-apk.yml` builds the bundle, wraps it in this shell
and uploads the APK to the rolling `apk-latest` release on every push:

```
https://github.com/Neo690/gods-eye-view/releases/latest/download/gods-eye-view.apk
```

Open that link on the phone, download, and install (the browser asks once to
allow installs from that source). Each build gets a fresh `versionCode`, so the
installer offers it as an update.

The CI key comes from the `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` repository secrets; the keystore
itself lives in `.signing/` locally and is git-ignored. Back that directory up:
losing the key means every later build is a different app and must be
uninstalled before it can be installed. A build signed by the CI key does not
replace an APK signed by a local debug key — the first switch needs one
uninstall, then updates are seamless.

## Land every CI build on a plugged-in phone

Downloading from the phone is fine once; while iterating, the phone is on USB
and the build is already published. `npm run apk:install` installs the newest
successful `Android APK` run on the connected device, and `npm run apk:watch`
keeps doing it — one install per new build, silent when the phone already has
it:

```bash
npm run apk:install      # once
npm run apk:watch        # every 2 minutes until Ctrl-C
```

It reads the runs API for the current branch, downloads the rolling release
asset and installs it with `adb install -r`. Because that asset carries the CI
key, the phone takes it as an update of the app it already runs — settings and
presets survive. A locally built debug APK cannot do that, which is why this
installs the published artifact rather than `dist/`.

Options: `--branch=<name>` (default: the current branch), `--serial=<device>`
when several phones are plugged in, `--interval=<seconds>`, `--force`,
`--dry-run`, `--adb=<path>` (also `$ADB`, then `$ANDROID_HOME/platform-tools`).
The last installed commit is remembered in `.gev-apk-install.json`, which is
git-ignored; delete it to reinstall the same build.

Unauthenticated GitHub API calls are limited to 60 an hour, so the default
interval is two minutes. Export `GITHUB_TOKEN` to poll faster, or when the repository is
private.

## What the shell provides

- `INTERNET` for tiles, fonts and feeds.
- `RECORD_AUDIO`, requested at runtime, granted to the page through
  `WebChromeClient.onPermissionRequest` — the dock's MIC button needs it.
- Runtime-granted coarse/fine location for the browser geolocation API.
- Back button: WebView history, then exit.
- Console messages are mirrored to logcat under the `GodsEyeView` tag.

## Live data: inside the app by default

The live layers (satellites, flights, military aircraft, vessels, CCTV,
traffic, launches, the HUD's AI summary) are served by this repository's Vite
middleware: the client asks its own origin for `/api/*` and the server does the
proxying, caching and key handling. A standalone APK has no Node process, so
those requests used to land on the asset store and come back 404 — every
network layer showed `UNAVAILABLE · HTTP 404`.

The shell answers them itself now. `LiveApi` implements the routes the layers
actually call, with the same upstream URL, cache window and response headers as
their `server/providers` counterparts:

| Route                                      | Upstream                        | Cache                                                     |
| ------------------------------------------ | ------------------------------- | --------------------------------------------------------- |
| `/api/celestrak/{group}`                   | CelesTrak GP/TLE text           | 6 h, stale on failure                                     |
| `/api/flights`, `/api/opensky`             | OpenSky `states/all?extended=1` | 10 s; 250 nm adsb.lol snapshot if OpenSky is rate limited |
| `/api/flights/track`, `/api/opensky-track` | OpenSky `tracks/all`            | 60 s                                                      |
| `/api/military`, `/api/adsblol/mil`        | adsb.lol `/v2/mil`              | 12 s                                                      |
| `/api/adsbdb/{callsign,aircraft}/{id}`     | adsbdb v0                       | 1 h                                                       |
| `/api/launches`                            | Launch Library 2                | 15 min                                                    |
| `/api/tomtom/status`                       | local                           | `hasKey: false`                                           |

The calls are issued from Java, so no CORS applies and no browser `Origin` is
sent. Nothing is uploaded and no key is involved: these are the public feeds.

Layers whose upstream needs a credential cannot be faked, so they answer the
way a keyless server does instead of 404 — the traffic layer falls back to OSM
roads and says so in its status chip, and live vessels report their AISStream
state. TomTom live tiles, CCTV, Google places and the AI summary still need
either a key or the server.

### Pointing the shell at a hosted server instead

Everything `/api/*` can also come from a hosted copy of this repository, which
covers the keyed routes too. The origin is a build input, `GEV_API_BASE`; when
it is set, `ApiForwarder` replays every `/api/*` request there and `LiveApi` is
not used.

That server also has to expose `GET /api/upstream?url=…`, because the feeds the
shell cannot fetch itself — GTFS-RT among them — come back through it (see
`src/data/inAppApi.js`). The route in `server/providers/upstream.js` is not an
open proxy: it relays only the exact URLs this build's transit registry
publishes plus the terrain heights path the sprite floors come from, over
https, with no redirects, an 8 MiB body cap and a per-IP throttle. A server that predates it answers 404 there, and the transit layer in
the APK shows `indisponible` even though the same feeds work in a browser.

```bash
npm run build && rm -rf android/app/src/main/assets/www/*   && cp -r dist/* android/app/src/main/assets/www/
cd android
GEV_API_BASE=http://127.0.0.1:5173 ./gradlew assembleRelease   # local server
```

For the GitHub build it is a repository variable, so no secret and no code
change is needed:

1. Deploy this repository's server somewhere always-on, with a build new
   enough to serve `/api/upstream`. The `Dockerfile` is the
   whole app (Vite serves the client and the `/api` middleware), so any
   container or Node host works — Render, Fly.io, Koyeb, a VPS. On a 512 MB
   instance use `Dockerfile.preview` instead: it builds the client once at
   image time and serves it with `vite preview`, which still runs every `/api`
   middleware, where the dev server's dependency pre-bundling needs twice that
   memory. Give it the environment it needs (`GEV_ALLOWED_HOSTS` for the public
   hostname, plus the optional provider keys) and note the HTTPS URL it answers
   on. `render.yaml` describes that service for Render's Blueprint flow.
2. Set the URL as a repository variable:
   `gh variable set GEV_API_BASE --body https://your-host` — or Settings →
   Secrets and variables → Actions → Variables.
3. Re-run the `Android APK` workflow. The log prints which server the build was
   wired to, and the app logs `Data server: …` on launch.

`edge-api/` is the same idea as a Cloudflare Worker: the keyless routes only,
deployable to a free Worker host if you would rather keep the phone's traffic
off the device. It needs no secret and no build step; see its own README.

Leaving `GEV_API_BASE` empty is the supported default: the app logs
`Data server: in-app live API` and the keyless layers above come alive with no
server at all.

A hosted server is the primary source once it is set, but not the only one: if
it answers `5xx` for a route `LiveApi` already serves, the shell re-serves that
request itself and logs `Data server answered 502 for …; served it in-app
instead`. That is what keeps the satellites alive on a phone when the host
cannot reach CelesTrak, which refuses rebroadcast from datacentre addresses.
A `4xx` is a deliberate answer and is passed through untouched.

### Known limit: POST endpoints

`WebResourceRequest` exposes a request's URL, method and headers but not its
entity, so only `GET`/`HEAD` can be replayed. The HUD's AI summary and the
voice tools post a body: with `LiveApi` they answer `405`, through a hosted
forwarder `501`. Both need the browser build against the server.
