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

## Put the desktop keys back into the phone

The phone keeps the provider keys its Provider Settings panel saves in its own
local storage. An in-place update preserves them — that is why `apk:install`
uses the published asset — but a reinstall, a switch between signing keys or a
"clear data" does not. `npm run apk:seed-keys` replays them from this machine:

```bash
npm run apk:seed-keys                       # the installed desktop app's .env
npm run apk:seed-keys -- --from=.env.deploy # a specific file
npm run apk:seed-keys -- --dry-run          # name the keys, write nothing
```

It hands the values to the app's own save route — the one the panel's SAVE
button posts to, with the same validation — over the WebView debugging socket,
so nothing is baked into the APK: the release is public and every phone would
share an embedded key. Output names providers and never prints a value:

```
reading keys from …\Gods Eye View\resources\gods-eye-view\.env
ignoring 2 name(s) the app does not know: URADMONITOR_USER_HASH, URADMONITOR_USER_ID
9 key(s) the app knows: AISSTREAM_API_KEY, …
wrote 9 key(s): AISSTREAM_API_KEY, …, WINDY_API_KEY
providers lit: 3/11 -> 8/11
```

The file is looked up in this order: the installed desktop app's own `.env`
(the one its Provider Settings writes), then `./.env`, then `./.env.deploy`.
Names the panel does not know are listed and skipped, so a server-only variable
cannot fail the whole save. Options: `--from=<file>`, `--serial=<device>`,
`--port=<n>` (default 9333), `--adb=<path>`, `--dry-run`, `--help`.

The app must be the one `adb` sees; the command starts it when it is not
running and waits for its socket. Keep the phone unlocked — the socket exists
only while the app lives. Run `npm run apk:install` first when the installed
build is older than the checkout.

## What the shell provides

- `INTERNET` for tiles, fonts and feeds.
- `RECORD_AUDIO`, requested at runtime, granted to the page through
  `WebChromeClient.onPermissionRequest` — the dock's MIC button needs it.
- Runtime-granted coarse/fine location for the browser geolocation API.
- Lifecycle management: WebView rendering loop, Web Workers and timers are paused
  when the app is backgrounded and resumed on return to conserve battery.
- Back button: Predictive Back (`OnBackInvokedCallback` on Android 13+) and
  WebView navigation history before exit.
- Edge-to-edge layout support with `viewport-fit=cover`.
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
| `/api/radiation`                           | BfS, Health Canada, Safecast, radmon.org, NOAA SWPC | In-app via `/api/upstream` |
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

Two more answers get the same treatment, because they describe the server's
address rather than the request. A `429` means the server — or the shared
address it egresses from, which it does not own — is being rate limited:
adsb.lol answers shared datacentre addresses with `429`, which emptied the
military and direct ADS-B layers on a phone whose own address read the same
feed, and the shell's `LiveApi.military()` and 250 nm snapshot serve them
instead. A refused `/api/upstream` is a decision about the server's own
deliberately narrow read-through list, so the shell answers that route itself
over its fixed host list — the same list it uses when no data server is set,
which is what the in-page fire, cyclone, radiation and radio adapters need to
reach their own feeds. Every other `4xx` is a deliberate answer (a bad request,
a foreign Host, a missing key) and is passed through untouched.

### POST endpoints

`WebResourceRequest` exposes a request's URL, method and headers but not its
entity, so the interception path replays `GET`/`HEAD` only. The page's own
`fetch` POSTs do not go that way: the in-app client hands them to the
`GodsEyeNative.post` bridge (`MainActivity` → `ApiForwarder.executePost`), which
carries the JSON body to the data server, so the HUD's AI summary and the Gemini
voice token work against a hosted instance. Without one there is no server to
post to: with `LiveApi` those routes answer `405`.

Both need the data server itself configured, not the phone: `/api/gemini/token`
mints the voice credential only on a host the service is published on (see
`GEV_ALLOWED_HOSTS`) and only with `GEMINI_API_KEY` in its environment, and the
AI summary spends the server's `OPENAI_API_KEY` the same way.
