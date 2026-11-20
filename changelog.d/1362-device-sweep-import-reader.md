- **Device Sweep**'s import path is now covered by tests that need no engine. The
  answers a picked file produces — the refusal of a file that is not an
  inventory, the 256-device cap, and how many devices were new since the last
  scan — lived inside the layer, which imports Cesium, so the one part of the
  row with no map in it could not be run without installing the whole rendering
  stack. The reading moved to `importScan.js`, which takes a picked file and the
  store and returns the line the row shows; the row keeps the picker wiring and
  delegates. What an operator sees is unchanged, and the three answers are now
  pinned by a test that drives them directly (Neo690, #1362).
