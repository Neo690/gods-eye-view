- A new **Fishing Effort** layer, off by default, draws Global Fishing Watch's
  apparent fishing hours as a grid of 0.1° cells over the current view, in the
  Movement group beside Live Vessels. A cell is a sum of modelled fishing hours
  the service derives from AIS behaviour — an activity area, not a vessel
  position — and the row says so, in the summary line and in the analyst
  records. The layer asks the app's own `/api/fishing-effort` route, which holds
  the operator's `GFW_API_TOKEN` on the server, runs one report at a time (a
  second concurrent report per token is refused upstream), caches each rounded
  viewport for six hours and serves that cache through an outage. Without a
  token the route answers `503`, and the row reports a missing key instead of an
  empty ocean. Views wider than 90° × 60° are refused locally: a hemisphere of
  daily aggregates is megabytes of ocean for a picture nobody can read, so the
  row asks for a closer view. A cell's size and opacity follow a square-root
  scale against the 95th percentile, so the many low-effort cells stay visible
  beside the few intense ones.
