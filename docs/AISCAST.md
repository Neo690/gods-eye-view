# aiscast — your own keyless vessels feed, folded into the AIS layer

aiscast (https://github.com/openwatersio/aiscast) is what the sources scan
picked for the vessels layer's second tier: a self-run AIS ingester whose
`/v1/vessels` page serves the received positions as a plain GeoJSON
FeatureCollection — no key, no third-party account, no ToS to accept because
it is your equipment receiving your channel.

This app treats it the way [LOCAL-RECEIVERS.md](LOCAL-RECEIVERS.md) treats
your own decoder feeds: an operator opt-in, fetched by this app's own server,
never the browser.

## Turn it on

1. Run or reach an aiscast instance and copy its vessels page URL, for
   example `http://localhost:8080/v1/vessels`.
2. Put it in `.env`:

   ```
   AISCAST_URL=http://localhost:8080/v1/vessels
   ```

3. Restart. The repo-tools connect page (like the receiver feeds') shows the
   source as configured; the AIS Vessels layer chip reads `Vessels + Aiscast`
   while vessels it carries are on screen.

Unset (the default), the layer runs on the resident AISStream feed exactly
as before; nothing else about the layer changes.

## What it does to the layer

- Your ingester's positions are merged into the layer by MMSI: a vessel
  both feeds carry shows the newest explicit position; a vessel only your
  feed carries is added, labelled `Aiscast` on its card sources; the resident
  feed stays the label of record for the rest.
- Rows are capped like everything else (`AISCAST_ROW_CAP` = 50 000 before
  the layer's own viewport and render caps), the document is cached one
  second server-side, and parallel reads share one upstream fetch.
- Aims wide: the fetch accepts the common field spellings
  (`mmsi`/`MMSI`, `name`/`ship_name`/`shipName`, `sog`/`speed`,
  `cog`/`course`, `time_utc`/`timestamp`/`last_heard`, or a numeric
  `last_position_epoch`) — see the normalization list in
  [DATA_SOURCES.md](../DATA_SOURCES.md).

## How it is fetched (why it is safe)

The aiscast URL is validated by the same `receiver-tap` rule as the local
receiver feeds:

- host must be loopback, a private (RFC1918) address, `localhost`, or a
  `*.local` mDNS name — a public host (e.g. `example.com`) is refused with a
  logged reason, never fetched;
- no query string, fragment, or credentials in the URL;
- redirects are refused; the response body is capped while it streams
  (2 MB), bad JSON or a non-FeatureCollection body is an explicit short
  failure status, and the socket is pinned to what the host name resolved.

Failures are honest and short: the route answers `status: 'unavailable'`
with a short code (`timeout`, `unreachable`, ...) and empty rows, and the
vessels layer runs on the resident feed. It never degrades the resident
feed's own health reporting; every failure lives inside the extra source.

## Where it sits in the code

- Server: `server/providers/vessels/aiscast.js` (validation, fetch,
  normalization, `/api/vessels/aiscast` route); mounted in
  `server/providers/local.js`.
- Browser: `src/sources/live/composeVessels.js` (the extra source, the
  merge-by-MMSI composition) wired in `src/data/aisLiveVessels.js`.
