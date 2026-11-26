- **Run one live layer instead of the whole canary.** The live layer canary's
  manual dispatch now takes a `layers` filter, so `ais-live-vessels` can be
  checked without paying for both full gates. The filter is resolved against the
  keyless and keyed manifests before anything expensive starts: a keyed layer
  skips the keyless preview and gate entirely and a keyless layer skips the
  keyed ones. Asking for a keyed layer whose credential is not configured fails
  the run instead of quietly testing nothing, and an id that neither gate can
  exercise fails with the ids each gate can run.
