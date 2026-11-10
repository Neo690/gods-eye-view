- **OSM Places** is a new viewport-bounded layer for named OpenStreetMap
  features — restaurants, shops, museums, parks, offices and craft businesses —
  drawn one city-sized view at a time through the existing opt-in Overpass
  proxy. Each point is coloured by family (food, shop, culture, services,
  other), its hover names the OSM kind (`cafe`, `museum`, `bakery`…), and the
  row reports the count. The query is capped at 2° per axis and 800 rows, so a
  continent-scale view is clamped to its centre and labelled as such; two
  same-named places at the same corner both remain, because each mapped element
  is its own place. With no `OVERPASS_UPSTREAMS` configured, the layer says so
  and sends no query. Its **Overpass Turbo** chip opens
  `overpass-turbo.eu` with the equivalent `{{bbox}}` query, the current centre
  and zoom, and `R` to run on load — the tyrasd/overpass-turbo editor is
  linked, not bundled, and the browser contacts it only when the chip is
  clicked. Data remains © OpenStreetMap contributors (ODbL 1.0); the layer is
  consistent with every other Overpass consumer and adds no key or dependency.
