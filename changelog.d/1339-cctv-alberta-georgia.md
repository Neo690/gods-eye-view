- Add two keyless CCTV source packs documented in Shadowbroker's public-source
  pipeline: **511 Alberta (TravelIQ)** — the same `/api/v2/get/cameras` CARS
  catalog as Ontario 511 (`511.alberta.ca`), filling the TCH corridor Open
  Calgary's municipal pack leaves out — and **511 Georgia (Georgia DOT)** — the
  DataTables camera table POSTed on 511ga.org/cctv, with WKT-POINT geography
  and per-image blocked flags on Georgia DOT hosts. Both pin frames to one
  registered origin (staging hosts rewritten, the feed's `navigatos` host
  misspelling normalized, plain http upgraded), fall back to id-hash headings
  at low confidence, and sit under their own caps and kill switches
  (`CCTV_ALBERTA_*`, `CCTV_GEORGIA_*`), with attribution entries in the Data
  attribution popover (yourname, #1339).
