# God's Eye View — iOS shell

A single-view WKWebView that runs the same Vite build the browser, the desktop
app and the APK run — served from `http://127.0.0.1:47821/` out of
`GodsEyeView/www` inside the app bundle. Nothing here is a second
implementation of the console: the shell only supplies a secure origin, the
device permissions and the place for the app to live.

## Why a loopback server instead of a custom scheme

`WKURLSchemeHandler` looks like the cheaper answer — no port, no server — but a
page on `gev://…` is **not** a secure context, and WebKit refuses
`navigator.geolocation`, `getUserMedia`, Web Workers and `navigator.storage`
there. The Secure Contexts standard names `http://127.0.0.1` as potentially
trustworthy, so that is what the bundle is served from:

- geolocation and the microphone work, with the plist purpose strings and one
  capture grant from `WKUIDelegate`;
- `/api/*` stays **same-origin**, so the page's existing fetches reach
  `ApiForwarder` with no CORS and no second origin;
- `localStorage` — where Provider Settings keeps the operator's keys — is keyed
  by origin, so the port is **fixed**. A port that moved between launches would
  silently lose every saved key.

`NSAppTransportSecurity → NSAllowsLocalNetworking` is what allows that local
connection; nothing else in the app talks plain HTTP.

## Requirements

- macOS with Xcode 15 or later (iOS 16 deployment target).
- [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`.
- Node 24 in the repository root.

## Build

```bash
# from the repository root
npm ci
npm run build

# optional: point the shell at a hosted copy of this repository, exactly as the
# APK uses GEV_API_BASE. Must be https — ATS allows plain HTTP only for loopback.
GEV_API_BASE=https://gev.example.com npm run ios:payload

cd ios
xcodegen generate
open GodsEyeView.xcodeproj
```

`npm run ios:payload` copies `dist/` into `ios/GodsEyeView/www` and writes
`ios/GodsEyeView/BuildConfig.swift`. Both are build artifacts and are
git-ignored: rerun it after every `npm run build`, or the app keeps serving the
previous bundle. `npm run ios:payload -- --clean` removes the staged copy and
resets the data-server origin.

The Cesium ion token and the Google Maps key are **not** passed to this script:
`vite build` inlines them into the bundle (`import.meta.env`), exactly as the
Android workflow does. Every other credential is server-side and must never be
inlined — this app ships in a public download.

Then, to run on a device, select the `GodsEyeView` target and choose your team
under *Signing & Capabilities*. A free Apple ID works, but its provisioning
profile expires after seven days; a paid developer account gives a year.

## Install on a device

Xcode's Run button is the path that always works. From a terminal, with the
phone connected and trusted:

```bash
xcodebuild -project ios/GodsEyeView.xcodeproj -scheme GodsEyeView \
  -configuration Release -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates build

xcrun devicectl device install app --device <UDID> \
  build/Build/Products/Release-iphoneos/GodsEyeView.app
```

`xcrun devicectl list devices` gives the UDID. This installs a new copy each
time and keeps the WebView's storage, so provider keys survive.

## What the shell provides

- `NSLocationWhenInUseUsageDescription` — "locate" centres the map and follows
  the vehicle, as on the phone build of the APK.
- `NSMicrophoneUsageDescription` — the dock's voice controls; the capture grant
  is issued in `WebViewController` for microphone requests only.
- ES modules, Web Workers, IndexedDB and `localStorage` on a real secure origin.
- Links written as `target="_blank"` (every provider key link) open in Safari
  instead of replacing the map; ordinary in-app navigation stays in the app.
- JavaScript alerts and confirms are shown as native dialogs, so a provider
  panel's confirmation cannot vanish.
- The listener is cancelled when the app is backgrounded and bound again on
  return; if the port is gone the app says so instead of leaving the map on
  screen with dead requests.
- Console output is mirrored to the device log — open Console.app and filter on
  `GodsEyeView`.

## Not published from CI, unlike the APK

`.github/workflows/ios-app.yml` compiles the shell for the simulator on a macOS
runner: that proves the Swift, the project spec and the staged bundle build
together. It deliberately publishes nothing — an installable `.ipa` needs an
Apple signing identity and provisioning profile, which belong to an account, not
to the repository. Add those as secrets and a paid macOS runner if an automatic
`.ipa` is wanted later.
