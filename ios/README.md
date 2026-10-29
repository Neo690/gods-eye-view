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
under _Signing & Capabilities_. A free Apple ID works, but its provisioning
profile expires after seven days; a paid developer account gives a year.

## Building without Xcode: xtool

The XcodeGen route above needs macOS. [`xtool`](https://github.com/xtool-org/xtool)
builds the same shell from a Swift package, signs it with your own Apple ID and
installs it over USB, on Linux or on Windows through WSL. Three files make this
shell an xtool project:

| File                   | What it is                                                       |
| ---------------------- | ---------------------------------------------------------------- |
| `ios/Package.swift`    | The same `GodsEyeView/` sources as a **library** SwiftPM target. |
| `ios/xtool.yml`        | Bundle identifier, product, plist and the `www` folder to pack.  |
| `ios/Info.xtool.plist` | The hand-written plist keys, without `$(...)` settings.          |

### Setting it up on Windows, inside WSL

This was done and verified on Ubuntu 24.04 in WSL, with no Mac and no Xcode.
The pieces, in the order they are needed:

1. **Swift 6.4**: xtool compiles SwiftPM manifests with the _host_ toolchain, so
   a Linux Swift is required even though the app itself is built for iOS.
   [swiftly](https://www.swift.org/install/linux/) keeps it in the user prefix:

   ```bash
   curl -O https://download.swift.org/swiftly/linux/swiftly-$(uname -m).tar.gz
   tar zxf swiftly-$(uname -m).tar.gz
   ./swiftly init --assume-yes
   swiftly install 6.4.1 && swiftly use 6.4.1
   swift --version   # Swift version 6.4.1
   ```

2. **Host C toolchain, `usbmuxd`, `libimobiledevice`** — one `apt` call, with
   root once: `libc6-dev` and `gcc` (no manifest links without the crt objects
   and `-lc`), `usbmuxd` (`xtool` talks to the device through it) and
   `libimobiledevice-utils` (gives `ideviceinfo`, the quickest way to see
   whether the phone is reachable):

   ```bash
   apt-get update && apt-get install -y libc6-dev gcc usbmuxd libimobiledevice-utils
   ```

3. **xtool itself**, the AppImage, in `~/.local/bin` (already on the WSL PATH):

   ```bash
   curl -fL "https://github.com/xtool-org/xtool/releases/latest/download/xtool-$(uname -m).AppImage" \
     -o ~/.local/bin/xtool && chmod +x ~/.local/bin/xtool
   xtool --version   # xtool 1.24.0
   ```

4. **The Darwin SDK.** `xtool setup` is login + SDK, and the SDK is generated
   from an **`Xcode.xip`**: the download needs an Apple ID in a browser (the URL
   is authenticated, so `curl` cannot fetch it), not a Mac. Take **Xcode 27.1**
   from <https://developer.apple.com/download/all/?q=Xcode>, then:

   ```bash
   xtool sdk install ~/Downloads/Xcode_27.1.xip   # or `xtool setup`, which asks for the path
   swift sdk list                                 # darwin
   ```

   Until that file is supplied, every `xtool dev` command stops at the prompt
   "Now generating the Darwin SDK" — the project is otherwise accepted.
   `swift package dump-package` in `ios/` is the check that needs no SDK: it
   validates the manifest with the Linux toolchain the same way a build will.

5. **The cable.** WSL does not see USB by default: bind the phone with
   [usbipd-win](https://learn.microsoft.com/en-us/windows/wsl/connect-usb)
   (`usbipd list`, then `usbipd bind`/`attach` on the Apple device). If `xtool`
   then reports `AFCClient.Error.muxError`, relay the connection from iTunes on
   Windows instead — the workaround is in
   [xtool#19](https://github.com/xtool-org/xtool/issues/19#issuecomment-2898986718).
   `ideviceinfo` answering is what proves the phone is actually reachable.

One Ubuntu 24.04 wrinkle worth knowing: the Swift driver links against
`libncurses.so.6`, and the distro ships only the wide variant
(`libncursesw.so.6`), so `swift --version` fails with _"cannot open shared
object file"_ until that library exists. `apt-get install -y libncurses6` is
the fix.

```bash
npm ci && npm run build && npm run ios:payload
cd ios && xtool dev
```

`npm run ios:payload` matters here: `www/` is what `xtool.yml` packs as a folder
reference, exactly as the XcodeGen spec does, so `BundleAssets` needs no change.
The folder exists in a fresh clone as a placeholder, which is why the package
target excludes it rather than declaring it a SwiftPM resource.

### The product is a library, and that is not a detail

A first `xtool dev build` here failed with `Error: No library products were
found in the package`, and still exited 0 with no `.app` — the quietest kind of
failure. xtool's planner selects `products.filter { $0.type == .autoLibrary }`,
so a package that only exposes `.executable` is invisible to it: xtool links the
library into the app binary itself and generates the entry point that calls
`@main`. Xcode has no say in this file (it reads `project.yml`), so the library
form serves both paths.

With that in place the build completes and writes `ios/xtool/GodsEyeView.app`:
a Mach-O arm64 executable with `_main` defined and `UIKit.UIApplicationMain`
imported, the 448-file `www/` copied in byte for byte, and an `Info.plist` that
keeps every `Info.xtool.plist` key — bundle identifier, scene delegate
`GodsEyeView.SceneDelegate`, ATS loopback exceptions, usage strings.

One value xtool cannot derive: it has no marketing version to read, so it writes
`1.0.0` where the Xcode spec declares `1.0`. `Info.xtool.plist` therefore pins
`CFBundleShortVersionString` to `1.0`, which is what makes the two builds report
the same version to TestFlight, the App Store and anything else that reads it.
The build number needs no such help — both paths produce `1`.

Everything else in the produced plist is checked against `project.yml` by
`node scripts/compare-ios-plists.mjs` (identifier, executable, display name,
deployment target, device family, required capabilities, ATS, usage strings,
scene delegate), so a future drift surfaces as a failing line rather than as an
app that behaves differently depending on how it was built.

The plists are two files on purpose. `GodsEyeView/Info.plist` names its
executable, identifier, module and versions through `$(...)` build settings that
only Xcode expands; xtool merges a plist verbatim, so a bundle built from that
file would install with a literal `$(EXECUTABLE_NAME)` and a scene delegate of
`$(PRODUCT_MODULE_NAME).SceneDelegate` — an app that launches to a black window.
`Info.xtool.plist` carries only what means the same in both worlds, and the
values xtool derives (`CFBundleIdentifier` from `bundleID`, `MinimumOSVersion`
from the platform in `Package.swift`) fill the rest. A key that matters at
runtime belongs in both files.

### Signing and installing from WSL

`xtool dev build` produces an unsigned bundle; installing it needs an Apple ID,
and that is not something a build script can supply:

```bash
xtool auth login     # API key (paid program) or password (any Apple ID, 2FA)
xtool dev run        # signs, installs and launches on a connected device
```

Without a login, `xtool dev run` stops with `Please log in with `xtool auth`
before running this command`. Two more things stand between a build and a phone:

- **`zip` must be installed** (`apt-get install -y zip`). `xtool dev build --ipa`
  shells out to it for packaging; without it the build succeeds and the packaging
  step fails with `Executable "zip" is not found`.
- **WSL must see the device.** Bind the iPhone with
  [usbipd-win](https://learn.microsoft.com/en-us/windows/wsl/connect-usb);
  `ideviceinfo` answering is the proof, and until it does, `xtool devices` is
  empty.

When the phone is not reachable from WSL, the useful artefact is the raw `.ipa`:
`npm run ios:ipa` builds the web bundle, stages it, runs `xtool dev build --ipa`
(on Windows through `wsl.exe`, `GEV_WSL_DISTRO` to pick the distribution) and
then reads the archive back — `Payload/GodsEyeView.app` present, the console
under `www/`, the pinned version, and no `_CodeSignature` it did not earn. It
writes `ios/xtool/GodsEyeView.ipa` (44 MiB, unsigned).

`npm run ios:studio` opens a local panel for the same steps, at
<http://127.0.0.1:47830/> — the toolchain's state, the connected phone by name,
five buttons (web build, staging, `.ipa`, verify, install) and the command output
as it runs. It is a page served by `node:http` on loopback, not a second
implementation: every button runs the command above, the verify button reads the
plist back out of the `.ipa` when `xtool dev build --ipa` left no `.app` to
compare, and **Install on device** runs `xtool dev run --usb`, which signs and
deploys. That last button stays disabled — with the missing half named in its
tooltip — until there is both an Apple ID session and a phone WSL can see. Sideloadly or AltStore signs it with a free
Apple ID on the Windows side — the same route the published `ios-latest` release
is installed by, and the WebView's storage survives re-signing, so provider keys
already on the phone are kept.

The same panel also ships as a Windows application of its own —
`npm run ios:installer` packages it with Electron into
`desktop/studio/release/iOS studio Setup <version>.exe` (an assisted, per-user
installer with a desktop shortcut and its own icon; `--dir` stops at the
unpacked app). The window is not a second panel: the installer carries the four
files above and starts them with the app's own binary, so it needs no Node
installation, and the page inside is the page `npm run ios:studio` serves. What
the app does need is a checkout, because its buttons run `npm run ...` there:
it opens on the folder it was built from, remembers whatever you pick in
**File ▸ Open project folder…**, and takes `--root=<path>` when neither is
right. A release build is smoke-tested with `--verify`, which starts the panel,
prints what it sees and exits without a window:

```bash
"desktop/studio/release/win-unpacked/iOS studio.exe" --verify
```

`npm run ios:shortcut` puts the shortcut back on the desktop and gives it the
panel's icon. A shortcut is machine state — a desktop path, an absolute target,
an icon — so a fresh clone has none: the command points it at whatever exists,
in the order a user would, the installed app first, then the unpacked build,
then the Node launcher.

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

## An unsigned `.ipa`, to sideload from Windows

When the computer that has Xcode is not the computer that has the phone, build
the `.ipa` here and sign it there:

```bash
# on macOS, from the repository root
npm run ios:ipa:unsigned
```

That compiles the shell with `CODE_SIGNING_ALLOWED=NO` and packages
`Payload/GodsEyeView.app` into `ios/build/unsigned/gods-eye-view-unsigned.ipa`,
with no team, no certificate and no Xcode setting to fill in. `--skip-build`
reuses an existing `dist/` instead of rebuilding the web bundle.

What it is worth being clear about: **an unsigned `.ipa` does not install on a
stock iPhone.** iOS runs signed code only, and nothing here changes that. The
file exists for tools on the operator's own machine — Sideloadly or AltStore on
Windows — which re-sign it with a free Apple ID and install it over USB. That
profile expires after seven days; re-running the tool renews it, and the
WebView's storage, where Provider Settings keeps the keys, survives the
renewal. No Mac is needed for that second step, only for the build above.

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
failing a push that could not have one. Add these under _Settings → Secrets and
variables → Actions_:

| Secret                              | What it holds                                               |
| ----------------------------------- | ----------------------------------------------------------- |
| `APPLE_CERTIFICATE_P12_BASE64`      | your signing identity, exported as a `.p12`, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD`        | the password you gave that `.p12`                           |
| `APPLE_PROVISIONING_PROFILE_BASE64` | the ad-hoc `.mobileprovision`, base64-encoded               |
| `APPLE_TEAM_ID`                     | your ten-character team identifier                          |
| `APPLE_SIGNING_CERTIFICATE`         | optional; `Apple Distribution` by default                   |

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
- **From Windows:** the file is signed for devices but not by _your_ Apple ID,
  so re-sign it first — Sideloadly or AltStore does that, and the WebView's
  storage survives, so provider keys already on the phone are kept.
- **Rebuilding the same commit:** run the `iOS app` workflow from _Actions → Run
  workflow_. Editing CI or a document publishes nothing by itself.

The ad-hoc profile expires, and so does the app built on it; the release notes
carry that date, and the fix is to publish again with a fresh profile.
