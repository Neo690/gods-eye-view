- A conjunction's **relative speed** is no longer read from a field the public
  feed never publishes. Every row of Space-Track's `cdm_public` omits
  `RELATIVE_SPEED` (0 of 60 measured), so the card's speed line was always
  "Unavailable"; it is now propagated at the TCA from the element sets of *both*
  objects and the value says which it is: the feed's own figure when it has one,
  `14.12 km/s (computed)` otherwise. Two things had to be fixed for the pair to
  exist at all. The GP window is a sample of the catalogue (1 200 of ~30 000
  objects) and pairs crews with debris, so **none** of the secondaries is in it:
  the missing half is fetched per catalogue number through the CelesTrak proxy's
  cache (`/api/celestrak/catnr/<norad>`, six-hour TTL, one request per object,
  capped at twelve per poll) before the events are placed. And the numbers did
  not match their spellings: GP returns `"06121"` zero-padded to five digits
  while the CDM says `6121`, so a plain string lookup found nothing for every
  object below 10 000 — normalised in both directions (7 of 60 events placed
  before, 14 after). An object CelesTrak does not know, or an event whose
  primary is absent, still places and still says the speed is unavailable, never
  `0`. `missingSecondaryNorads()` is pure and unit-tested; the completion step is
  best-effort, so a failed per-object read costs one card's speed, not the layer.
