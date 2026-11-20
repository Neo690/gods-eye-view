- A scene that is torn down mid-load no longer leaves its startup deadlines
  behind. The imagery stack is given 15 seconds and the photoreal tileset 12, and
  both waits used to outlive the scene: a console closed inside those windows
  still fired the stack's stall warning, and the tileset's timer kept running for
  a result nobody would see. Both budgets now take the scene's cancellation
  signal, so destroying it disarms the timers and suppresses the warning. Waiting
  no longer is not ownership, though: a tileset that lands after the teardown is
  still handed to its owner and destroyed rather than left to hold its GPU
  memory, which is also what keeps the deferral order honest on that path
  (Neo690, #1361).
