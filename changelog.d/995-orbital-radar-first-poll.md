- Orbital Radar now paints on its **first** poll. The CelesTrak proxy keeps the
  element sets each refresh replaced (memory and
  `.gev-cache/celestrak-<group>-previous.json`) and serves them at
  `GET /api/celestrak/previous/<group>`, a cache read that never starts an
  upstream request and refuses anything that is not one group name. A session
  with no stored `gev.satellite-watch.baseline.v1` seeds its reference from that
  generation and diffs immediately, so the switch shows its inferred manoeuvres
  on the first reading instead of recording a baseline and waiting for the next
  poll. The baseline it stores afterwards is the fresh generation, so later
  polls compare against this reading as before. A group with no previous
  generation answers 404, and the layer then reads the Orbit Changes layer's own
  cached baseline from the device — read-only, never cleared — before giving up
  and recording a new one.
