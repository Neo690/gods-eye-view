- **The UPDATE panel installs the Android update itself.** Its Android action
  used to open the published APK in the browser and leave the operator to find
  it in notifications. The shell now downloads the `apk-latest` asset in-app and
  commits a `PackageInstaller` session, so the platform's own confirmation is
  the only step left. The archive is checked before it is offered — package
  name, a strictly higher `versionCode` and the signing certificate already on
  the device — because the installer's generic "app not installed" names none of
  those failures. Android 8 and later need a per-app grant; the shell opens
  Settings → Install unknown apps and the panel says so. Only https URLs on the
  project's own release, plus the `objects.githubusercontent.com` redirect, are
  accepted, so a compromised page cannot hand the shell an arbitrary APK. The
  panel's own-platform button and row share the action and one-at-a-time guard,
  and progress arrives through `window.__gevUpdate`, translated with the rest of
  the panel. Other shells keep the external link.
