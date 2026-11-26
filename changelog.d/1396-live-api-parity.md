- **The Android and iOS live APIs can no longer drift apart silently.** The
  platform contract now reads both `LiveApi.java` and `LiveApi.swift`, compares
  every dispatched `/api` route and every host in their upstream allowlists,
  and fails CI when either side has a route or host the other lacks. It also
  checks every transit feed URL in `src/data/transitFeeds.js` and every explicit
  GBFS host in `src/data/gbfsSource.js` against both lists, so adding a new
  source on one shell is a release check rather than an iOS 404. The two WMS
  weather-tile fallbacks that only the Android shell keeps are named as the one
  allowed exception; any other asymmetry fails.
