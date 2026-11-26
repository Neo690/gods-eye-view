- The live layer canary now reports only the skips that mean something. A
  nightly run listed every keyed layer without a credential — the normal state of
  a fork — in a table nobody could act on; it now lists the requested layers a
  filtered run could not exercise, plus a half-configured pair, and nothing else.
  Both gates also wait for a successful build: the keyless preview used to start
  even when the bundle failed, so a broken build produced a port error and a gate
  that tested a `404`. The tracking step makes one idempotent `gh label create
  --force` call instead of swallowing the "already exists" error, and reuses the
  issue state it already listed instead of reading it again, saving one API call
  per run.
