- **Compare each canary run with the last one.** The live layer summary shows
  each layer's previous status plus the layers that broke, degraded or recovered
  since the previous run, and marks a provider that has returned EMPTY or
  EXTERNAL for three runs in a row. The streak raises an alert but not the exit
  code: those outcomes stay non-blocking because the upstream may be at fault,
  while a FAIL or MISSING layer still fails the gate.
