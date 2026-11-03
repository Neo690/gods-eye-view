- Merge an operator-configured **aiscast** ingester (Open Waters AIS,
  self-hosted, keyless GeoJSON) into the AIS Vessels layer as an opt-in
  extra source. The server validates `AISCAST_URL` against the local
  receiver-tap rule (loopback, RFC1918, `localhost`, `*.local`; no query,
  fragment or credentials), fetches it with the shared hardened feed path
  (no redirects, body capped at 2 MB while streaming, socket pinned to the
  resolved addresses, 2 s timeout, one-second cache with coalesced reads)
  and answers the short `/api/vessels/aiscast` snapshot (`configured`,
  `status` live/stale via a 30-minute staleness window, failure codes kept
  short and text-light). The browser folds the rows into the resident
  AISStream snapshot by MMSI (newest explicit observation wins, extra-only
  vessels labelled `Aiscast`, the chip reads `Vessels + Aiscast`), and an
  unconfigured or missing route stops after one request, leaving the
  resident feed exactly as before (yourname, #1334).
