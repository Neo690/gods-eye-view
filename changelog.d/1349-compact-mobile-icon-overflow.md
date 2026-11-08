- On a phone the **provider chooser and the required Cesium attribution left
  the screen**: the compact-layout rule anchored the chooser with the bare
  `left: calc(56px - 50vw)` but its containing block is `#gev-voice-control`
  (280px, centred by the dock), not the 92px mic column the maths assumed, so
  the whole "OpenAI ..." select sat at −124px — off a 360px phone entirely, and
  the settings gear beside it pointed at nothing. The anchor now cancels the
  containing block explicitly with the same `calc(50% - 50vw + <edge>)` idiom
  the landscape rule already uses, so the chooser lands 10px off the screen's
  left edge at every width. And Cesium's own widget credit bar (wordmark +
  "Upgrade for commercial use" + the "Attribution des données" link) measured
  451px on that same 360px viewport, so the attribution link — the one credit
  the platform terms require to stay legible — spilled off-screen; the bar now
  wraps inside the map's 10px gutters and the wordmark steps down 28→18px with
  the credit cluster above it. Measured on a 360×728 @3x viewport: chooser at
  10px, credit bar 265px, no element overflowing the screen.
