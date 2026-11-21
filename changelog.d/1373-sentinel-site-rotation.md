- **The Sentinel no longer inspects the same address every time.** Each pass
  picked `inspectionPoint` as the nearest record of the winning layer, and the
  nearest record to where the spider had just scanned was the one it had just
  left — so static catalogs (bases, towers, fixed cameras) were revisited at the
  same point forever. The ranking remembered when it last looked at a *layer*
  (ten minutes), never at a *site*, and one patrol cycle across the enabled
  layers outlasts that window. Sites now have their own memory: the nearest
  record whose place has not been scanned in twenty minutes wins, a cooling
  catalog rotates to its longest-unvisited site, and ties break on a rounded
  coordinate key so the walk stays reproducible. `pickInspectionSite` in
  `src/layers/aiAgent/patrol.js` holds the rule, with tests for rotation,
  cooldowns, positionless rows and tie-breaking (Neo690, #1373).
