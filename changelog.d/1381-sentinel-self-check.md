- **The Sentinel gate can prove it still bites.** `npm run
  qa:sentinel-rotation -- --self-check` sabotages the Radio Sites boot: a hook
  installed before the navigation clears `gev:sentinel:visited-sites` before any
  script of the reloaded document runs, so the Sentinel has to walk back to the
  site it just left however late the layer reads its memory, and the boot then
  asserts the key really is gone. The mode exits 0 only when that boot fails on
  the rotation assertion itself — a green sabotaged run means the assertions
  have become decoration, and a failure on anything else means the gate is
  broken for another reason. The sabotaged boot stays out of `BOOTS`, so a full
  run can never mistake it for a verdict; `--case` alongside the mode exits 2,
  and the log quotes the assertion it produced.
