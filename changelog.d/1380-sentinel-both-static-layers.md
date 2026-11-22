- **The Sentinel's rotation now proves both static layers side by side.**
  `npm run qa:sentinel-rotation` gains a third boot that enables Radio Sites
  and Mapped Installations at once, answers both APIs with the existing fixed
  fixtures, and watches six scans. No layer may take two scans in a row, every
  scan must stand exactly on one of that layer's sites, and each layer must
  visit both of its own sites; with every site cooling by the third visit, each
  layer must then fall back to its longest-unvisited site — the anti-starvation
  and cooldown properties a single-layer boot cannot show. Failure evidence now lands under
  `qa-artifacts/sentinel-rotation/<case>/`, so the coexistence boot's page,
  console and network records never share a directory with a single-layer
  case's files.
- **One boot's failure no longer ends the gate.** The three boots run one
  after another, each with its own console-error list and its own evidence
  directory, and the run reports every failure before exiting non-zero: a
  broken single-layer case cannot hide whether the pair still rotates. The new
  `--case <name>[,<name>]` argument runs only the named boots, so a developer
  or a retry can ask for `radio-sites-and-installations` alone; an unknown name
  exits 2 with the list of boots.
- **The single-layer reload boots now run end to end.** They never had: a
  direct `page.reload()` on the loaded app detaches the frame, because the
  app's pagehide cleanup rewrites the tab URL while the navigation is in
  flight. The gate parks the tab on `about:blank` and loads the app again in
  that same tab, and the reloaded page must re-request its API — the hit count
  from the first page can no longer satisfy the fixture check. One boot opener
  now owns the page, fixtures, layer preparation and camera for every case, so
  the reload path runs the same code a second time.
- **The gate now proves what it claims.** Each boot fails unless the page
  actually requested its fixture URL, so an empty 200 cannot stand in for the
  fixed data. The camera is held on the fixture view until it reads back
  before the Sentinel spawns — the app could still apply a restored view and
  move the spider's start — which makes the pair's walk reproducible, and the
  spec pins that order. A failure record now also carries the Sentinel's stats
  and its stored site memory, so a starvation verdict names the target it chose.
- **Mapped Installations joins the patrol contract.** The layer drew OSM and
  Google Places records but exposed no position reader, and the Sentinel's
  `inspectionPoint` skips a layer without one, so no installation could ever be
  inspected and the gate's military case could not pass. `patrolSites.js` reads
  the layer's records as positioned sites (id, label, latitude, longitude),
  refusing a record whose coordinate is absent instead of planting it at 0,0,
  and the layer exposes both `getPatrolSites` and `getAllPositions` over it.
  The patrol reads the explicit `getPatrolSites` first and keeps
  `getAllPositions` as the older alias.
- **A reload no longer forgets which sites were scanned.** The layer writes
  `{version: 2, sites}` to `sessionStorage` under `gev:sentinel:visited-sites`
  when a scan finishes and reads it once on enable, dropping entries past the
  site cooldown. A forbidden store, junk JSON, another version or a full quota
  costs the memory, never the patrol — the gate's reload assertions were
  reading a key nothing wrote.
- **The repeat penalty now outlives the scan.** It only applied while a target
  was still set, and the target is cleared for the rest after every scan, so
  the nearest catalog could win two scans in a row: the new coexistence boot
  caught the fourth scan staying on Radio Sites. The layer keeps the last
  inspected layer id past the scan, so the walk still prefers somewhere else.
- **Two unowned modules are registered.** `src/app/degradedMode.js` and
  `src/app/application.js` (with the new installations reader) were imported
  without a package-boundary owner, which failed `check:boundaries`.
