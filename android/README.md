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

## What it does not carry

The repository's own Vite server hosts `/api/*` proxies (OpenSky/AIS/adsb.lol
helpers, military installations, routes, transit, TomTom tiles, Google search,
the AI summary, key setup). A standalone WebView has no Node process, so those
layers report a network error exactly as the web build would without the
server. Everything that talks to public endpoints directly — Cesium imagery,
the HUD, layers, scenes, display controls, the radio browser — works offline
from the bundled build.

To exercise the proxied layers on a phone, run `npm run dev` on the computer
and use `adb reverse tcp:5173 tcp:5173` with the phone pointed at
`http://127.0.0.1:5173`; that path is intentionally not baked into the APK.
