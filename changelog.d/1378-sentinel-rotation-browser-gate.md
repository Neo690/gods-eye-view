- **The Sentinel's static-site rotation now has a deterministic browser gate.**
  `npm run qa:sentinel-rotation` runs two independent cases: Radio Sites with
  two ANFR fixture sites, then Mapped Installations with Creil and
  Villacoublay. Each case enables only its static layer and the Sentinel,
  starts the camera near the first site so the order is not decided by a
  coordinate tie, and verifies that the layer exposes both provider ids at
  their exact coordinates. After the first scan it reloads the real page: the
  same tab's sessionStorage must make the next scan skip that site, while the
  following scan rotates back to it. The bundled military-names pack is stubbed
  empty so only the two fixture bases can enter the layer. Failure keeps page,
  console and network evidence under `qa-artifacts/sentinel-rotation/`. The
  local preview run reports `qa-site-a` → reload → `qa-site-b` → `qa-site-a`,
  and `osm:node:91001` (Creil) → reload → `osm:node:91002` (Villacoublay) →
  `osm:node:91001` (Neo690, #1378).
