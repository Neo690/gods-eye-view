- **The live canary now raises and clears an alert.** A completed run records
  itself in a `Live layer canary health` tracking issue and comments there when
  it fails or recovers, carrying the `live-layer-canary-failing` label while it
  is red. The issue doubles as the canary's history, so no new service, bucket or
  artifact is involved, and a run that stopped before a gate could write a report
  still reports the failure it can see.
