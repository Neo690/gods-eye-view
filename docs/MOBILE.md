# Mobile apps (Android and iOS)

God's Eye View runs on phones and tablets in two ways.

## 1. Installable web app (PWA)

No store, no build. Open the deployed site, then:

- **Android (Chrome):** menu ⋮ → **Install app** / **Add to Home screen**.
- **iOS (Safari):** Share → **Add to Home Screen**.

The app opens full screen with its own icon. `public/sw.js` caches the app
shell, Cesium runtime and 3D models so it starts offline; live feeds, `/api`
proxies and map tiles always come from the network. The worker is registered
only in production builds (`src/pwa/register.js`).

## 2. Native store apps (Capacitor)

`android/` and `ios/` are Capacitor projects. `capacitor.config.json` points
the native WebView at the deployed site (`server.url`), so every Netlify
deploy updates the apps without a store release. Remove `server.url` to ship
the local `dist/` build inside the app instead (map and voice keys baked into
the build must then accept the app origin).

Requirements: Android Studio (Android), a Mac with Xcode (iOS), and developer
accounts to publish (Google Play, Apple Developer Program).

```bash
npm install
npm run build          # produces dist/ (copied into the apps)
npm run mobile:sync    # copies web assets + config into android/ and ios/
npm run mobile:android # opens Android Studio → Run / Build > Generate Signed Bundle
npm run mobile:ios     # opens Xcode → select a team, Run / Product > Archive
```

After changing `public/logo.svg`, run `npm run mobile:icons` to regenerate the
native icons and splash screens.

Identifiers: app id `app.netlify.godseyeview`, name "God's Eye View". Change
`appId` in `capacitor.config.json` (and the Android `applicationId` / iOS
bundle identifier) before the first store upload if you want your own domain.

Note: Apple may reject apps that only wrap a website (guideline 4.2); the
native permissions for microphone and location are declared so voice control
and "my location" work inside the app.
