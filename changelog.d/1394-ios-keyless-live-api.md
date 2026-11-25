- The iPhone app now draws the public layers without a hosted server, as the APK
  does. `ios/GodsEyeView/LiveApi.swift` answers CelesTrak, OpenSky flights and
  tracks (with the 250 nm adsb.lol fallback), the merged keyless ADS-B military
  feeds, adsbdb enrichment, Launch Library 2 and `/api/health`, and serves the
  bounded `/api/upstream` read-through the bundle's own in-page API expects;
  `src/data/inAppApi.js` recognises the loopback origin, so weather, wind, fires,
  cyclones, radiation, space weather, radio, transit, GBFS and terrain run the
  same normalisers they run on the desktop. A source that needs a provider key
  — TomTom traffic flow, AIS vessels, Global Fishing Watch — answers
  `503 {"error":"no_key"}` with the route named, instead of an outage, and a
  configured `GEV_API_BASE` is still read first (Neo690).
