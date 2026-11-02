- **Pin the moving overlays to the frame, not to a timer.** Under a
  continuous drag the painted dot lagged behind its exact projection by up
  to ~30 device pixels at globe scale: an overlay source marked `moving`
  for the collision arbiter was re-solved only every 125 ms, so a fast
  rotation let the camera move on between two solves. The Israeli transport
  layer now registers its three overlay sources with `solveIntervalMs: 0`
  and a guard test pins it, so every rendered frame re-solves and the dot
  tracks the camera (measured on the phone at full-globe rotation:
  horizontal lag 0.6 px mean, root mean square ~8 px worst frames,
  yourname, #1329).
- **Measure each overlay entry once per frame.** The same drag exposed the
  label painters' allocation budget: `measureOverlayEntry` rebuilt the
  title wrap and the detail split for every candidate on every solve. It
  now caches the wrap/fold by identity of the entry's title, details and
  the measured width on the entry record, so a steady frame measures
  without allocating (the allocation probe's `phase5-cctv-projection`
  worst case drops from ~43.6 kB/frame to under 5 kB/frame on the node-24
  microbenchmark, yourname, #1329).
- **Keep the projection hot path off the heap.** The same drag's steady frames
  still allocated: screen coordinates stored fractional device pixels (a new
  boxed double on every projected candidate), the placement sizing and pooled
  rect/centre fields stored unreconciled floats, and the piecewise near–far
  paint-scale curve behind `paintScale` crossed a non-inlined helper boundary that
  boxes its doubles for every moving entry. The projector now truncates
  screen coordinates to integers, rounds the placement spans and pooled
  centres it derives from them, and restates the distance curve locally (the
  same inlining the altitude fade already uses). On the calibrated Node 24
  allocation runner the Phase-3 + vessels workload drops from 62,607 to
  24,588 bytes per steady frame median (138.8 to 54.5 B per candidate per
  frame), still under the unchanged 154 B/candidate ceiling and 87,500-byte
  frame gate, with every other workload re-derived by the same gate test
  (yourname, #1329).
