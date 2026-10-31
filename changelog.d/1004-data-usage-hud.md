- The data usage readout now sits **in the HUD telemetry window**, under the AIS
  row, instead of floating above the microphone. That slot is the mic pill's own
  corner: measured on a phone, the line was 31 px wide over the pill and had to
  hide its session total to fit. In the telemetry window it reads as one more
  number beside the coordinates, and a phone keeps both the rate and the total.
  A shell without that window still falls back to the mic anchor, and the line
  still waits for a host that renders after it.
- The counters now include **the app's own traffic**. Resource Timing reports
  `0` bytes for a cross-origin response without `Timing-Allow-Origin` — which is
  every feed the app fetches, and every answer the Android shell synthesises — so
  the readout used to show only what the map engine loaded (14 MB of Google
  tiles, with 0 B for the feeds themselves). The app's `fetch` is now tapped
  once: the declared `Content-Length` when the answer has one, otherwise a clone
  read chunk by chunk, so a body is counted as it is consumed and never kept.
  The returned response is untouched, the original `fetch` is restored with the
  meter, and Resource Timing skips `fetch` entries so no byte is counted twice.
