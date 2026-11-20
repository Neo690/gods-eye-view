- Startup waits are bounded, so a provider that never answers can no longer
  leave the loading cover up for good. The photoreal tileset gets 12 seconds and
  the imagery stack 15 before the degraded path is taken, and the cover names
  the reason instead of repeating "Initializing photorealistic world..."; a
  tileset that lands after its budget is destroyed rather than leaked. A startup
  that is still running after 30 seconds names the step it stopped at and lifts
  the cover, which leaves a degraded but usable console rather than a frozen
  screen. The welcome card's wait for style restoration is bounded as well: it
  begins after the application is ready, when the startup guard has already
  stood down, so a share link that never answered used to hold the cover up
  behind a finished console. Restoration now gets 10 seconds before the cover
  comes down anyway, and a restoration that lands later still applies its
  styles. The guard is also covered against a browser-only failure: Cesium's
  WebGL context and a software rasterizer are slow, not infinite, and the bound
  is what tells slow from stuck (Neo690, #1358).
