- **The pair's cooldown now has to survive a reload.** The boot that enables
  Radio Sites and Mapped Installations together watched six scans and stopped
  there, so nothing proved the tab's memory still drove the walk after a page
  load — the one thing `sessionStorage` exists for. It now reads that memory,
  reloads the tab, and watches one scan per layer, each of which must land on
  the site the memory itself names as that layer's longest-unvisited. Which
  layer goes first is left free on purpose: the reloaded spider ranks them from
  a position the gate does not control, and two consecutive runs were observed
  taking the pair in different orders while both resumed at the same two sites —
  so the assertion covers the memory, not the ranking it cannot pin.
- **The names-pack check now speaks before the walk does.** It ran at the end of
  the boot, so a renamed asset failed on the rotation assertion first and blamed
  the Sentinel for a change that never touched it. It now runs as soon as the
  reloaded scans are observed and before any assertion about which site was
  picked: with the same sabotaged build, the old order died on `two scans after
  the reload` at 149.7 s, the new one on the pack message at 146.0 s.
- **`--self-check` covers the pack check too.** The mode runs two sabotaged
  boots: Radio Sites with its site memory wiped, and Mapped Installations with
  its stubs answering every request but filing it under a name the check cannot
  read. Both must fail as expected. In the second boot the walk and the memory
  stay exactly as a green run leaves them, so the pack check is the only thing
  that can fail there — the control is proven to bite, not merely to pass.
- **A stale build can no longer pass quietly.** On a loopback preview the gate
  compares `dist/index.html` with the newest file under `src/` and warns when
  the build is older, so a green run cannot report on a tree that no longer
  exists. It is a warning, not a failure: a checkout whose mtimes are arbitrary
  should not turn the gate red.
