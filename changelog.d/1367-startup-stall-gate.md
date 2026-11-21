- The browser gate now drives the **startup guard** end to end. `createApplication`
  takes an optional `stallPhase`, set from `?qaStall=<phase>` in `main.js`: that
  phase is never constructed and the loop waits forever, which is the only way
  into the guard's stall path from a browser — every real startup phase either
  settles or is synchronous. Nothing in the UI sets the parameter, and without
  it the field is null.
- `scripts/qa-device-sweep.mjs` gains a third boot with `?qaStall=tools`, the last
  phase, so the cover hides a finished console. The gate waits for the guard and
  checks that it held its full 30 s, that the banner names the step the cover
  stopped at, that the line is still up 1.5 s later, that the cover is lifted and
  `aria-hidden`, and that a real control behind it answers: the Device Sweep
  toggle turns ON and its row reads the sweep already stored.
- That new step found the stall line disappearing: the status banner belongs to
  the shell's loading feedback, which recomputes its text, visibility and
  `data-state` on every tick, so a sentence written straight into the element was
  hidden by the next one — the guard had also started setting `data-state`
  itself, racing the shell's owner of it. `ShellFacade.showGlobalStatusNotice`
  now posts a persistent notice, which outranks the loading summary and keeps the
  banner up until it is cleared; `main.js` uses it whenever the shell exists and
  falls back to the elements only for a stall in a phase that never built the
  shell. `data-state` is the shell's alone again.
- A fourth boot stalls on `controls`, the phase that builds the shell, so the
  status banner is in the document with no loading feedback driving it. That is
  the one path where `main.js` writes the banner's elements directly instead of
  posting a shell notice, and the gate checks it end to end: the sentence names
  the step the cover stopped at, the label took it, the stale detail is empty,
  no `data-state` is set by anyone, the cover is lifted and `aria-hidden`, and
  the line is still up 1.5 s later.
- A unit test pins the seam itself: the stalled phase is never constructed, the
  application state reads `starting`/`tools` — what the guard names the stall
  from — and `start()` never settles.
