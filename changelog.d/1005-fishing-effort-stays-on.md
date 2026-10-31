- Fishing Effort now **stays enabled from a global view** and says so. The
  layer answered `false` from `update()` whenever it had nothing to draw — a
  camera wider than 90° × 60°, a camera with no rectangle, a missing Global
  Fishing Watch token, a failed refresh — but the manager reads `false` as a
  *refused transition* and switches the layer back off, so the row reset to
  "Global Fishing Watch · jamais" and its own "Zoom in to load fishing effort"
  note could never appear. Those four states now resolve `true`: the layer
  handled the update and its row carries the reason, while a genuine refusal
  (disabled layer, no data source, an aborted or superseded request) still
  returns `false`. Seen on a phone at 12 011 km, where every attempt to enable
  the layer threw `LifecycleRejectedError` and reverted within a second.
  The unit tests pin the contract: wide view, absent rectangle and a throwing
  source each keep the layer on and leave the note or the error in the row.
