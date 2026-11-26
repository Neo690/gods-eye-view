- **A targeted canary run no longer cancels the nightly one.** The live layer
  canary's concurrency group is now derived from the resolved `layers` filter
  instead of the fixed `live-layer-canary` group, so asking for
  `ais-live-vessels` and the scheduled run can proceed side by side. A filter is
  resolved first in a small `select` job — a concurrency group cannot read a step
  output — which also means a mistyped layer fails in seconds rather than after
  the dependency install. The nightly run keeps the shared `full` group, so two
  nightlies still cancel the older one, and the same filter run twice still
  cancels itself.
