- **The Sentinel gate can prove it still bites.** `npm run
  qa:sentinel-rotation -- --self-check` runs the Radio Sites boot with the
  tab's `gev:sentinel:visited-sites` wiped after the reload and before the next
  scan, so the reloaded Sentinel has to walk back to the site it just left. The
  mode exits 0 only when that boot fails on the rotation assertion itself: a
  green sabotaged run means the assertions have become decoration, and a
  failure on anything else means the gate is broken for another reason and says
  nothing about the rotation. The wipe refuses an already-empty store, so a
  memory nothing wrote cannot pass as a proof, and the log carries the
  assertion's own words instead of only the verdict. `--case` alongside the
  mode exits 2: the self-check runs its own boot rather than a selection.
