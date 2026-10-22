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

## What the shell provides

- `INTERNET` for tiles, fonts and feeds.
- `RECORD_AUDIO`, requested at runtime, granted to the page through
  `WebChromeClient.onPermissionRequest` — the dock's MIC button needs it.
- Runtime-granted coarse/fine location for the browser geolocation API.
- Back button: WebView history, then exit.
- Console messages are mirrored to logcat under the `GodsEyeView` tag.

## Live data: point the shell at a running server

The live layers (satellites, flights, military aircraft, vessels, CCTV,
traffic, launches, the HUD's AI summary) are served by this repository's own
Vite middleware: the client asks its own origin for `/api/*` and the server
does the proxying, caching and key handling. A standalone APK has no Node
process, so those requests used to land on the asset store and come back 404.

`ApiForwarder` fixes that without a second implementation: when the build
carries a server origin, every `/api/*` request the page makes is replayed over
the network from Java and the response is handed back to the WebView. The call
is issued outside the browser, so the server's source gate sees no foreign
`Origin` and no CORS preflight is involved.

The origin is a build input, `GEV_API_BASE`:

```bash
npm run build && rm -rf android/app/src/main/assets/www/* \
  && cp -r dist/* android/app/src/main/assets/www/
cd android
GEV_API_BASE=http://127.0.0.1:5173 ./gradlew assembleRelease   # local server
```

For the GitHub build it is a repository variable, so no secret and no code
change is needed:

1. Deploy this repository's server somewhere always-on. The `Dockerfile` is the
   whole app (Vite serves the client and the `/api` middleware), so any
   container or Node host works — Render, Fly.io, Koyeb, a VPS. Give it the
   environment it needs (`GEV_ALLOWED_HOSTS` for the public hostname, plus the
   optional provider keys) and note the HTTPS URL it answers on.
2. Set the URL as a repository variable:
   `gh variable set GEV_API_BASE --body https://your-host` — or Settings →
   Secrets and variables → Actions → Variables.
3. Re-run the `Android APK` workflow. The log prints which server the build was
   wired to, and the app logs `Data server: …` on launch.

Leaving `GEV_API_BASE` empty keeps the app self-contained: everything that
talks to public endpoints directly (Cesium imagery, HUD, layers, scenes,
display controls, radio) still works, and the server-backed layers report
`UNAVAILABLE`.

### Known limit: POST endpoints

`WebResourceRequest` exposes a request's URL, method and headers but not its
entity, so only `GET`/`HEAD` can be replayed. The HUD's AI summary and the
voice tools post a body and therefore still answer `501` through the shell;
those need the browser build against the server.
