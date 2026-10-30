- A new **Orbit Changes** layer, off by default, reports where an orbit has
  changed between successive CelesTrak element sets — the technique every public
  manoeuvre tracker uses, rebuilt from the element sets instead of borrowed from
  one. It diffs semi-major axis, inclination and eccentricity over the `geo`,
  `stations` and `visual` groups and reports a change past 1.5 km, 0.02° or
  0.0002, coloured by the estimated Δv and labelled with it. The copy is
  deliberately narrow: a TLE is a fit, so the layer says an **orbit changed**,
  never that a satellite manoeuvred, and the row carries the thresholds and the
  word "inferred". The previous element set is remembered in `localStorage`
  (identity and three elements per object, no element lines) so a relaunch still
  compares against the last session; the first refresh of a fresh install
  records a baseline and reports nothing rather than inventing changes, an
  object missing from either side is skipped because a launch, a decay or a
  catalog edit is not a manoeuvre, and the sub-satellite point is SGP4 at the
  changed set's own epoch. Changes stay on the globe for 24 hours. The layer
  reads the existing cached CelesTrak route, so there is no second upstream and
  no new credit. The sites that prompted it are recorded in `DATA_SOURCES.md`:
  `azmth.space` and `orbitalradar.com` have no public API or export and are not
  scraped, and `warmonitor.app` publishes none either — no conflict layer was
  added rather than inventing incidents.
