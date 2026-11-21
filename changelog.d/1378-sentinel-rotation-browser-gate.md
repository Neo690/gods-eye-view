- **The Sentinel's site rotation now has a deterministic browser gate.**
  `npm run qa:sentinel-rotation` loads only Radio Sites and the Sentinel,
  answers the cell-tower request with two fixed sites, and starts the camera
  nearer `qa-site-a` so the order is not decided by a coordinate tie. It first
  checks that the layer exposes both provider ids at the fixture coordinates,
  then watches two successive scans and asserts that they hit `qa-site-a` and
  `qa-site-b` in that order at their exact coordinates. Failure keeps page,
  console and network evidence under `qa-artifacts/sentinel-rotation/`. The
  local run reports `id=qa-site-a` then `id=qa-site-b` (Neo690, #1378).
