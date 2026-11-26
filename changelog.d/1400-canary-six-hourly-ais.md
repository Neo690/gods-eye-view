- **The AIS live layer now runs every six hours.** The live layer canary has a
  second schedule that runs only `ais-live-vessels`, the one keyed layer with no
  keyless fallback, so a credential that stops working is found between nightly
  runs instead of a day later. The cron is mapped to its layers in
  `scripts/live-layer-selection.mjs` and keeps its own concurrency group, so it
  never cancels the nightly run. A scheduled layer whose credential is missing is
  skipped and reported rather than failed, because an unset secret must not go
  red four times a day.
