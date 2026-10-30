- When OpenSky has no usable snapshot, the civil Flights layer now asks the
  operator's own **ADS-B Exchange** key first. The proxy reads one 250 nm point
  snapshot around the view anchor (`gateway.adsbexchange.com`, `X-Api-Key`,
  the same `ADSBX_API_KEY` its military feed already uses), caches it for 20 s,
  single-flights concurrent views and serves the last copy if a read fails;
  only when the key is unset or that read fails does the keyless adsb.lol
  fallback answer. Both are normalised to the OpenSky state-vector shape, so the
  renderer is unchanged and the response names the provider it used
  (`X-Flight-Source`), which the Flights row reports. ADS-B Exchange is opt-in
  because its terms allow personal, non-commercial use and forbid
  redistribution: the app bundles no key, and the provider row in Provider
  Settings now offers the field with that restriction stated.
