- A new **Satellite Watch** layer, off by default, carries the four satellite
  sources in one row with four switches that are genuinely independent: Azmth,
  Orbital Radar, War Monitor and N2YO, each with its own count, its own error
  slot and its own colour, so a refused key or a dead catalogue costs only its
  own switch. What each switch reads is stated in the row rather than implied:
  Azmth and Orbital Radar read CelesTrak element sets (the same public flux
  those applications run on), War Monitor reads the keyless TLE catalogue its
  own bundle loads, and N2YO reads its documented API through the app's own
  `/api/n2yo/above` route, which holds the operator's `N2YO_API_KEY` on the
  server and never ships it in the bundle. Object positions are SGP4 at the refresh instant, not at the
  TLE epoch, and Orbital Radar keeps its own baseline so the Orbit Changes layer
  and this one never consume each other's comparison. The layer polls every five
  minutes, which stays well inside N2YO's free 1 000-call hour. The audit behind
  it is recorded in `DATA_SOURCES.md`: azmth.space publishes no API,
  orbitalradar.com's `/api/m/…` answers 403 without a token and reserves TDM
  rights in its robots.txt, and warmonitor.app has no satellite API of its own —
  so nothing is scraped and the public flux each one uses is read directly.
