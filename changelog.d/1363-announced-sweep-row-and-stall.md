- **Device Sweep**'s line of feedback is announced, not just painted. The row is
  the only place an action is answered — how many devices an import added, why a
  file was refused, that a place was set or that a location was unavailable — and
  the line was a plain `div`, so an operator using a screen reader heard nothing
  after pressing IMPORT SCAN. The layer declares `announceInfo` once for itself
  and the panel gives that line `role="status"`, `aria-live="polite"` and
  `aria-atomic="true"`; a provider row that repaints its counts on every refresh
  stays a plain line, so nothing is announced over the globe for free
  (Neo690, #1363).
- A startup that outlives its 30-second budget now names the step it stopped at
  in the status banner instead of on the loading cover. The cover is lifted and
  marked `aria-hidden` in the same breath, so the sentence written into it was
  read by nobody: no sighted operator could see it and no screen reader could
  announce it. The line goes to `#global-loading-status`, which already carries
  `role="status"` and `aria-live="polite"`, through the banner's single label
  writer so its split-flap host is never authored twice;   the banner's stale loading detail is cleared with it, and the remedy it prints is still a reload
  (Neo690, #1363).
- The loading cover's own line is a polite live region too: `.loader-status`
  carries `role="status"`, `aria-live="polite"` and `aria-atomic="true"`, so
  every step a slow start stops on — configuring the viewer, the keyless globe,
  a tileset that timed out, a shared view being restored — is announced as it
  changes instead of being painted for nobody. Nothing on screen moved or
  reworded (Neo690, #1363).
