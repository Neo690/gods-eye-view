- On a phone this fork keeps the **pre-tab-shell console** it shipped to
  version 1140: the full HUD, the dock row and the compact sheets under 720px,
  with no bottom tab bar. The upstream phone shell (`mobileShell.js` +
  `mobile-shell.css`, adapted from #203 in the v0.3.0 merge) — which replaces
  all of that with one tab bar and one sheet at a time — becomes opt-in: only a
  document carrying a `?mobile=` search parameter hands the shell a media query
  that can match, every other load (including the Android WebView, which loads
  bare `index.html#…`) is handed `(max-width: 0px)` and keeps the old
  arrangement. The shell's wiring stays in place for those who ask for it.
