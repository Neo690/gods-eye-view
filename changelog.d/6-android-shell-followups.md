- Android releases are signed with the v3 scheme alongside v2, and the app no
  longer allows device backups. v2 alone could not survive a signing-key
  rotation: Android reads the new key as a different app, so updating meant
  uninstalling first — which took the provider keys stored on the phone with it.
  v3 makes a rotation an update instead. Backup is closed for the same reason
  those keys exist: `android:allowBackup="false"` keeps a device backup from
  carrying them off the phone (Neo690, #6).
- "Add a zone" works again for the panel's own default radius. The field carried
  `step: 0.5` measured from a minimum of 0.25 km, so 5 km, 120 km and 5.1 km all
  failed the browser's step check — and constraint validation runs before
  `submit`, so the button did nothing and said nothing. The field now takes
  `step: 'any'`, the way the latitude and longitude fields beside it already do,
  which leaves the bounds to the module's own check, reported in the app's
  language (Neo690, #6).
- `npm run apk:seed-keys -- --check` reports which providers the phone has
  configured and writes nothing: one read of the app's own status route, no
  `.env`, no install, and the adb forward left the way it was found. It names
  configured and missing providers by id — the status carries presence, never a
  value — and reports a status it could not read as such, rather than as every
  provider missing (Neo690, #6).
