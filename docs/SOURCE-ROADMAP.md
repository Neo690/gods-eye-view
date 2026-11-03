# Data source roadmap

A ranked plan for the next data sources, from the November 2026 candidate scan.
Every integration must still ship like the existing ones: a runtime-fetched
source with its license named in [DATA_SOURCES.md](../DATA_SOURCES.md) and a
`DATA_CREDITS` entry in `src/data/dataCredits.js`. Nothing a scan says is
license confirmation — re-verify each source at integration time and keep the
unofficial ones behind operator opt-in, like Eismoinfo.

The ranking measures one thing — **value per friction**, for "global risk
picture" layers the stack does not have yet.

| # | Source | Why | Auth | License |
|---|--------|-----|------|---------|
| 1 | **EMSC SeismicPortal** (FDSN + WebSocket) | Global seismic push; USGS-only today misses European/rapid detection | None (FDSN JSON; `wss://www.seismicportal.eu/standing_order/websocket`, `action: create/update`) | CC BY 4.0 |
| 2 | **aiscast** (openwatersio) | Widens the vessels layer with a self-hosted, keyless AIS feed | None (own instance → JSON/GeoJSON) | Unofficial lane — self-operated, so no third-party ToS, but document the upstream |
| 3 | **Copernicus EMS + EFFIS + GDACS** | The missing global "disasters" tier: activations, burned perimeters + FWI forecast, multi-hazard | None per source | Copernicus / public-domain GDACS |
| 4 | **RIPE RIS** | The Internet view (like netmon, but worldwide) | Varies by product | RFC-documented research service |
| 5 | **ENTSO-E Transparency Platform** | First real "grid beat" layer: generation by technology, cross-border flows, 15 min | Free token (email `transparency@entsoe.eu`) | Open data, attribution |
| 6 | Backfill: **NOAA NDBC + CO-OPS** (buoys, tides, surge), **USGS Volcano** (VONA + status), **Movebank** (animal tracking), **SpaceX-API** (launches enrichment) | Cheap, well-keyed fills per existing layer families | None | Public domain / per source |

## 1 — EMSC (SeismicPortal)

Complement, not replacement, for the USGS earthquake layer:

- REST: FDSN JSON catalog, keyless.
- Real-time: Standin-Order WebSocket gives sub-minute `created`/`updated` events;
  the first genuinely push-fed source in the client.
- European and participative detection (LastQuake) coverage the USGS feed lacks.
- Integration shape: same snapshot contract as `src/layers/earthquakes/source.js`
  first; the push channel becomes a follow-up once the poll layer exists.

## 2 — aiscast (Open Waters AIS) — LANDED

- Keyless GeoJSON from a self-run ingester; merges into the vessels layer as an
  additional normalized source rather than a new layer.
- Landed: set `AISCAST_URL` to your ingester's `/v1/vessels` (or any keyless
  GeoJSON endpoint) and the vessels layer folds it in by MMSI. The setup story
  is [docs/AISCAST.md](AISCAST.md); the fetch path shares the local-receiver
  hardening (loopback/private host, pinned socket, no redirects, body cap).

## 3 — Global disasters tier

- **Copernicus EMS Rapid Mapping**: `public-activations-info` REST, paginated,
  WKT areas of interest, damage COGs. Show activations (type, grade, AOI).
- **EFFIS**: WFS `maps.effis.emergency.copernicus.eu/effis` — NRT burned
  perimeters (MODIS/VIIRS) + FWI forecast; completes US-only NIFC. One probe
  call returned a transient 502; re-verify at integration time.
- **GDACS**: `gdacsapi/api/events/geteventlist/SEARCH` — one multi-hazard
  extractor (bbox + severity included) when a single "watch" layer is cheaper.

## 4 — RIPE RIS

Internet routing visibility (announcements/ROAs). Pick one RIS product
(bulk/export) rather than the full platform; keep it off by default like Eismoinfo.

## 5 — ENTSO-E

One operator registration unlocks load/generation/cross-border series across
~40 countries at 15-minute resolution, 400 req/min. Store the token like the
other user-supplied keys; never bundle it.

## 6 — Backfill (per-layer enrichment)

NDBC realtime2 station text + CO-OPS tides/surge; USGS volcano status (US) and
`volcanoesGVP` (global); Movebank animal tracks; SpaceX-API for the launches
layer. All keyless; parsers are small.

## Blocked or avoided (verified by the scan)

- **NOTAM**: FAA NMS needs a portal registration with an unreadable spec;
  EUROCONTROL EAD is a B2B contract. No official path — only commercial paid
  connectors (RapidAPI RapidAPI Link NOTAM, 1,000 req/month free tier; read its
  commercial terms before ever using it).
- To avoid: `airplanes.live` (403s non-feeders), public TTN MQTT (does not
  exist as shared), ChirpStack demo (simulated), `notams.fun`, the seismod
  Mastodon (no trace), AISHub (reciprocity: you must feed a receiver).

## Open license flags

- **Avalanche Canada**: base URL visible, but the license asks for written
  permission — do not integrate until clarified.
- **MeteoSwiss OGD**: STAC at `data.geo.admin.ch`, keyless, stations on 10-minute
  cadence with ETag/304 freshness — fine, low priority.
- **WHO DON** OData: keyless; field names unconfirmed until a real call.
