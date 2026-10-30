- **Space-Track** joins Satellite Watch as a fifth, independently
  switchable source: the official element sets from the 18th Space Defense
  Squadron plus the public conjunction (CDM) feed. The account is read only by
  `/api/spacetrack/gp` and `/api/spacetrack/cdm`, which log in once, keep the
  session for six hours and cache inside Space-Track's own published limits —
  GP once an hour, CDM once per eight hours — instead of ignoring them, because
  an account that queries harder is suspended. Element sets and conjunctions
  are placed at their real positions: satrec propagation for the sets, and for a
  conjunction the primary object's sub-satellite point at TCA, since a CDM
  carries relative geometry rather than a latitude and longitude. The
  conjunction labels come first in the ambient list, state TCA and the predicted
  miss distance, and the analyst records expose the pairing for query. Without
  `SPACETRACK_USER` / `SPACETRACK_PASSWORD` the switch says the account is
  missing instead of showing an empty sky.
