- **Pin the moving overlays to the frame, not to a timer.** Under a
  continuous drag the painted dot lagged behind its exact projection by up
  to ~30 device pixels at globe scale: an overlay source marked `moving`
  for the collision arbiter was re-solved only every 125 ms, so a fast
  rotation let the camera move on between two solves. The Israeli transport
  layer now registers its three overlay sources with `solveIntervalMs: 0`
  and a guard test pins it, so every rendered frame re-solves and the dot
  tracks the camera (measured on the phone at full-globe rotation:
  horizontal lag 0.6 px mean, root mean square ~8 px worst frames,
  yourname, #1328).
- **Measure each overlay entry once per frame.** The same drag exposed the
  label painters' allocation budget: `measureOverlayEntry` rebuilt the
  title wrap and the detail split for every candidate on every solve. It
  now caches the wrap/fold by identity of the entry's title, details and
  the measured width on the entry record, so a steady frame measures
  without allocating (the allocation probe's `phase5-cctv-projection`
  worst case drops from ~43.6 kB/frame to under 5 kB/frame on the node-24
  microbenchmark, yourname, #1328).
