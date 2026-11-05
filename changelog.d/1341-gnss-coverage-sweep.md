Optional user-initiated coverage sweep for the GNSS-integrity layer.

- The panel row carries a **Coverage sweep** chip (labelled **Stop sweep** while
  running). One press fetches up to 24 whole-degree anchors on a 5° lattice
  within ±20° of the view centre, nearest first, one at a time at a 3 s pace,
  marked `sweep=1` to `/api/gnss-integrity`. Rows enter the same 30-minute
  window dated by the proxy's observation clock — no new evidence path, no
  error/retry lane of the feed's own.
- Per-sweep budget 24 (GNSS_SWEEP_MAX_QUERIES), one sweep per view per window,
  no re-ask of an anchor read inside the window; the view anchor itself stays
  the ordinary route's job. Disabling or destroying the layer aborts the
  in-flight read and stops the loop; an abort is not a refusal.
- The sweep stops on its first server refusal — every refusal after a shock
  budget 429 or a kill-switch 403 is guaranteed to be another refusal. Sweep
  amounts show in stats (`sweep`), progress in the row info, and the method in
  a frozen `gnssProvenance.sweep` section (definedBy GEV, validated false).
- Server side (`gnssIntegrityProxy`): sweep requests count against a separate
  per-client hourly window — `GNSS_SWEEP_MAX_PER_HOUR`, default 60, explicit
  `0` removes the guard — and `GNSS_SWEEP_ENABLED=0` refuses every sweep with
  403 while the ordinary per-view route keeps working.
- An in-flight read is aborted by disable or destroy; an abort is never
  reported as a refusal. Failure summaries carry the sweep's totals, and a
  successful one adds no note to the row info. Tests pin the plan geometry,
  budget, pacing plumbing, recency stamp, refusal stops, abort path, chip
  labels, stats and provenance, plus the source's `sweep=1` marking, its 403
  translation and the proxy's kill switch and hourly budget.
