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

## Published from CI, once it is given an identity

`.github/workflows/ios-app.yml` has two jobs. The first compiles the shell for
the simulator on a macOS runner, which proves the Swift, the project spec and the
staged bundle build together; that needs nothing but the repository. The second
archives the app, exports an **ad-hoc** `.ipa`, checks it, and publishes it as
`gods-eye-view.ipa` in a rolling `ios-latest` release, the way `apk-latest`
carries the APK.

The packaging job cannot sign anything on its own, because an installable iOS
app is signed by an Apple account. It looks for the signing material in the
repository secrets and, when it is absent, prints a notice and skips instead of
failing a push that could not have one. Add these under *Settings → Secrets and
variables → Actions*:

| Secret | What it holds |
| --- | --- |
| `APPLE_CERTIFICATE_P12_BASE64` | your signing identity, exported as a `.p12`, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | the password you gave that `.p12` |
| `APPLE_PROVISIONING_PROFILE_BASE64` | the ad-hoc `.mobileprovision`, base64-encoded |
| `APPLE_TEAM_ID` | your ten-character team identifier |
| `APPLE_SIGNING_CERTIFICATE` | optional; `Apple Distribution` by default |

Ad-hoc means the app installs on the devices the profile names and no others.
They do not have to be connected to the runner, but they do have to be in the
profile when it is created, so register every phone you care about at
[developer.apple.com](https://developer.apple.com) first. Ad-hoc export also
needs a paid Apple Developer Program membership: a free Apple ID produces a
development identity, which is a different export method — change `method` in
`ExportOptions.plist` inside the workflow to `development` if that is what you
have.

Producing each value:

```bash
# the identity: Keychain Access → My Certificates → your Apple Distribution
# certificate → Export… as a .p12, then
base64 -i cert.p12 | tr -d '\n'

# the profile: developer.apple.com → Profiles → your Ad Hoc profile → Download
base64 -i profile.mobileprovision | tr -d '\n'

# the team id: "Apple Team ID" on your developer account's membership page
```

The workflow refuses, with the reason, a profile that does not belong to
`com.godseye.view` under your team, one that has expired, and one that names no
devices — so a release cannot carry an `.ipa` nobody can install. It then checks
the exported app itself: the console is inside it, the bundle identifier is the
one the profile covers, the signature names your team, and the profile embedded
in the app is the one you supplied. Signing material lives only in a throwaway
keychain on the runner and is deleted at the end of the job.

To get the published `.ipa` onto a phone:

- **From a Mac:** open Finder, select the device, drag `gods-eye-view.ipa` onto
  it.
- **From Windows:** the file is signed for devices but not by *your* Apple ID,
  so re-sign it first — Sideloadly or AltStore does that, and the WebView's
  storage survives, so provider keys already on the phone are kept.
- **Rebuilding the same commit:** run the `iOS app` workflow from *Actions → Run
  workflow*. Editing CI or a document publishes nothing by itself.

The ad-hoc profile expires, and so does the app built on it; the release notes
carry that date, and the fix is to publish again with a fresh profile.
