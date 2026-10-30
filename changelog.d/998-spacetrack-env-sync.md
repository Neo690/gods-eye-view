- The deployed Space-Track routes (`/api/spacetrack/gp`, `/api/spacetrack/cdm`)
  now get their account from the deploy itself. `render.yaml` declares
  `SPACETRACK_USER` / `SPACETRACK_PASSWORD` (`sync: false`), and the workflow
  syncs every server-only key from a repository secret of the same name —
  N2YO, then both Space-Track values — with the same read-then-write check, so
  a rotation needs no dashboard trip. The run ends by calling the GP route once
  and validating a real two-line element set: one call is what the account's
  hourly allowance permits, and it also leaves the route's hour-long cache warm
  for the layer. The CDM feed is deliberately not touched: three downloads a
  day is too scarce to spend on a health check.
