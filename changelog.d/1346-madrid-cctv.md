- New opt-in CCTV pack for **Madrid** (Ayuntamiento de Madrid, CC BY 4.0). The
  city's open-data catalog ships as a KML: one placemark per camera with its
  number, name, position and current frame, so the pack is one keyless request
  (~240 KB, 357 cameras) rather than a paged JSON crawl. Each placemark becomes
  a camera on `informo.madrid.es/cameras/<name>.jpg` — the cache-buster is
  dropped and any other host or path is skipped, so the frame proxy keeps one
  pinned directory — with published positions, a low-confidence id-hash heading
  for the calibration gizmo, and a `CC BY 4.0 — Ayuntamiento de Madrid` credit
  registered in the Data attribution popover. Off by default: set
  `CCTV_MADRID_ENABLED=1`; `CCTV_MADRID_MAX_SOURCES` (default 400, nearest
  Puerta del Sol and Plaza de Castilla first) and `CCTV_MADRID_URL` tune it.
  Tests pin the parse (escaped `<img>`, KML `lon,lat` order, duplicate numbers),
  the host and bbox refusals, the cap ordering, the redirect refusal and both
  sides of the opt-in.
