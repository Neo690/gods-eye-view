- The **Plate Reader** row now switches on. `lifecycle.js` calls `update()` as a
  layer turns on and reads `false` — or a missing method — as a refused
  transition, so the switch snapped straight back to off with
  `update is not a function` in the console and the READ chip never appeared.
  The layer has nothing to poll (a read happens when the row asks for one), so
  the tick resolves true and the row stays on.
