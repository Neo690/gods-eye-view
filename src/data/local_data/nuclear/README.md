# Nuclear power plants

Worldwide nuclear power plants bundled for the local infrastructure layer.

- Source: [Wikidata](https://www.wikidata.org) (Wikibase entity data, SPARQL)
- License: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (public
  domain dedication)
- Feature count: 201
- Snapshot date: 2026-11-26
- Runtime file: `nuclear.geojsonl` (GeoJSON Lines, one Feature per line)

## Query

Run against `https://query.wikidata.org/sparql` with an identifying User-Agent.
Every item is an instance of `Q134447` (nuclear power plant) that carries
coordinates (`P625`).

```sparql
SELECT ?item ?itemLabel ?coord ?countryLabel
  (SAMPLE(?cap) AS ?capacity)
  (SAMPLE(?opLabel) AS ?operator)
  (SAMPLE(?start) AS ?startDate)
  (SAMPLE(?stateLabel) AS ?state)
  (SAMPLE(?retire) AS ?retirement)
WHERE {
  ?item wdt:P31 wd:Q134447 ; wdt:P625 ?coord .
  OPTIONAL { ?item wdt:P17 ?country }
  OPTIONAL { ?item wdt:P2109 ?cap }
  OPTIONAL { ?item wdt:P137 ?op . ?op rdfs:label ?opLabel . FILTER(LANG(?opLabel) = "en") }
  OPTIONAL { ?item wdt:P571 ?start }
  OPTIONAL { ?item wdt:P5817 ?stateItem . ?stateItem rdfs:label ?stateLabel . FILTER(LANG(?stateLabel) = "en") }
  OPTIONAL { ?item wdt:P730 ?retire }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr,de,es,ru,ja,zh". }
}
GROUP BY ?item ?itemLabel ?coord ?countryLabel
```

## Filters applied

Kept: plants whose state of use (`P5817`) is *in use*, *in partial operation*,
*starting up* or *under construction*, plus plants with no recorded state of use
and no service-retirement date (`P730`).

Dropped:

- no English/multilingual label, or coordinates outside the valid range;
- state of use *cancelled*, *proposed building or structure*, *postponed*,
  *project*, *decommissioned*, *nuclear decommissioning* or *plan*;
- a service-retirement date (`P730`) when no positive state of use is recorded;
- items also typed as a cancelled, proposed or unfinished project (`P31` in
  `Q811683`, `Q21514702`, `Q1570262`, `Q105955498`, `Q64728694`, `Q1371819`,
  `Q1255828`, `Q2475641`, `Q130386771`) unless a positive state of use overrides
  it, and research reactors (`Q1438105`).

## Fields

Each Feature carries `name`, `tags` (`operator`, `country`, `start_date`,
`plant:source`, `plant:output:electricity`, `plant:status`, `wikidata`), plus
flattened `operator`, `country`, `status`, `start_date`, `capacity_mw` (net
electrical capacity in MW from `P2109`) and `output` (`"4800 MW"`).

Capacity and operator are optional in Wikidata: 179 of 201 entries have a
capacity and 37 countries are represented. A missing field is left out rather
than guessed.

## Refresh

Re-run the query, apply the filters above, re-sort by name and replace the file.
Wikidata is edited continuously, so counts drift; update the feature count and
snapshot date here and in `DATA_SOURCES.md` at the same time.
