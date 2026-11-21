- A startup that stalls now leaves a **degraded console** instead of a
  half-built one behind a message. The guard reports the phases that never
  settled, and the app turns off every control whose component is missing: a
  host marked `data-requires` (the SCENES panel, the drawing tool, the file
  import group, the recent-imagery panel) gets `aria-disabled`, its buttons and
  inputs are disabled, each says `Unavailable until you reload`, and the banner
  sentence names the features — `Unavailable: scenes, drawing and voice.` — so
  the operator learns what is off instead of pressing a control that answers
  nothing.
- The stall notice is persistent and now carries the actions that end it:
  `RELOAD` starts the boot again, `DISMISS` takes the banner down without
  pretending the missing components arrived. The action row works on both
  paths — the shell's persistent notice once it exists, and the element
  fallback for a stall in a phase that never built the shell (Neo690, #1369).
