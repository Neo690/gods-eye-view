- Show the CCTV layer's dataset-backed hardware identity: when the catalog join
  confirmed a camera's model against the bundled cctv-camera-database snapshot,
  the panel summary adds `MODEL AXIS-Q6135-LE (DATASET EXACT)` beside the source
  token — or `(DATASET SERIES)` when the feed's own numbering only named a
  dataset series — and the public camera state carries `modelRef`/`modelMatch`
  for UI consumers. Both fields are validated browser-side (a ref that is not a
  dataset slug, or an unknown grade, reads as no confirmation), so a malformed
  pair from the wire never reaches the HUD, and cameras with no confirmed row
  show exactly what they showed before. Translated in every locale, with the
  boundary, token and grading paths pinned by tests.
