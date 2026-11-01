- An **update option** now lives in the chrome itself. The new compass-row
  button (a `system_update_alt` glyph, harmonised with the other globe-action
  buttons) opens one small panel that asks GitHub for the releases of
  `Neo690/gods-eye-view` and answers per platform: the three rolling channels
  (`apk-latest`, `ios-latest`, `desktop-latest`) are listed with their newest
  artefact's publish time and a state — *update available* when the running
  bundle is older than the channel's newest release, *current* when it is not,
  *channel not published* when the rolling release does not exist yet (iOS
  until signing lands in CI). The bundle knows itself through two stamps
  `build/vite.js` bakes in at compile time — its build moment and its short
  commit — so the comparison needs no server-side version file. Taking the
  update goes through the shell's own openExternal: the browser download on
  Android, `shell.openExternal` on the Windows desktop, Safari on iOS; the
  other channels open the release page. A late network answer never repaints
  a panel the user has already closed, Malformed or unreachable release data
  degrade to per-channel "not published" lines rather than a thrown error,
  and every string is translated in the five locales. (yourname, #1330)
