- **The Sentinel gate waits for the camera, not for a clock.** Every boot used
  to sleep a flat eight seconds after each navigation to outlast the start-up
  cinematic, which cost time on a fast machine and still raced it on a loaded
  one: a flight that outlived the sleep overwrote the view the boot had just
  set. `waitForStartupFlight` now samples the camera pose and leaves as soon as
  it comes to rest — five still samples after the flight has moved, or sixty if
  a restored share view had nothing to fly, so the 500 ms start-up timer is
  still outlasted — and fails after 30 s instead of proceeding on a camera that
  never settled. The three boots went from 351 s to 255 s on the same machine
  (Radio Sites 78 → 60 s, Mapped Installations 145 → 100 s, the pair 128 →
  96 s), and all three still pass.
