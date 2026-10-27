- Military flights now read two receiver networks instead of one. `/api/military`
  merges adsb.lol and adsb.fi by ICAO24 — an aircraft one network heard is no
  longer missing because the other did not — keeping the row with a position and
  then the freshest position, and naming every feed that answered in the layer's
  source row. Each feed keeps its own cache and cooldown, so a rate-limited one
  never costs the others their data. ADS-B Exchange can be added on top with your
  own `ADSBX_API_KEY`. The Android shell merges the same two keyless feeds
  (yourname, #1318).
