- **`--self-check` proves the pair's anti-starvation assertion bites.** The mode
  ran two sabotaged boots, so nothing showed whether the rule that no layer may
  take two scans in a row still had teeth: the coexistence boot that models it
  was only ever run green. A third sabotaged boot silences one layer's patrol
  sites after its first scan, so the Sentinel still sees that layer's records
  but no position to walk to, drops it as a candidate, and inspects the only
  catalog left twice in a row. The boot must fail on the alternation's own
  wording; if that assertion is ever removed, the per-layer count fails before
  it and the self-check reports the mismatch instead of passing. Two consecutive
  runs failed at the same scan 2, in 47.8 s and 48.6 s, and the unsabotaged pair
  boot still walks its six scans and reload green.
