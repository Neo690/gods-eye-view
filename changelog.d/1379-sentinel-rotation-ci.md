- **The Sentinel's static-site rotation gate now runs in CI.** The existing
  Device Sweep browser job already installs Chrome and deterministic fonts,
  builds the production bundle and runs `vite preview` on port 4173; it now
  runs `npm run qa:sentinel-rotation` after the Device Sweep gate, covering
  both Radio Sites and the Creil/Villacoublay installations on every pull
  request without a second browser setup. If the Sentinel step fails, its
  evidence is uploaded as `sentinel-rotation-gate-evidence`, separately from
  the Device Sweep artifact (Neo690, #1379).
