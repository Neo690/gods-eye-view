- New **Camera Advisories** layer: the cameras this server already catalogues,
  joined by brand and model to CISA's CSAF OT/ICS advisories and NVD's CVE API,
  drawn by severity with the advisory, its CVEs and a link on hover. The join
  is a publication fact, not an observation of the hardware — the installed
  firmware is unknown, nothing is ever sent to a camera, and the payload says
  so (`firmwareObserved: false`, `deviceContact: "none"`). Only exact model or
  dataset-series matches are flagged; an advisory naming just a brand stays
  counted as brand-level context, and cameras whose hardware the catalogue does
  not name are counted as unjoined rather than guessed at. Outbound reads are
  pinned to the two advisory hosts with redirects refused and bodies capped,
  NVD's keyless allowance caps brand queries at four per refresh (the rest are
  reported as not queried), and the six-hour answer survives a failed refresh
  as a stale-labelled previous result. `CAMERA_ADVISORIES_ENABLED=0` disables
  the route; `CAMERA_ADVISORIES_TTL_MS`, `_MAX_CISA` and `_MAX_BRANDS` tune it.
  Translated in every locale, with the join boundaries, host pinning, payload
  honesty flags and token/credit paths pinned by tests.
