- **A renamed names pack is no longer the Sentinel's fault.** The Mapped
  Installations boot answers the layer's worldwide names pack with an empty
  fixture so the walk stays hermetic, but nothing checked that the pack was
  fetched at all: an asset rename would have stopped matching its stub, let the
  real pack load, and failed the boot on an unexpected walk — a rotation
  verdict for a change that never touched the rotation. `installFixtures` now
  counts stub hits as well as fixture hits, and `assertPacksRead` fails the boot
  with the asset's name, both candidate URLs (`osm_military_names`, the dev
  server's path, or `/assets/names-...`, the hashed one the build produces) and
  the hint that the stub list is what needs updating. It runs at the end of a
  boot that reloads, because the layer fetches the pack lazily and only after a
  second load: the coexistence pair never asks for it, so an earlier check would
  fail a boot that is working. Verified with both stubs renamed to match
  nothing: the boot fails with that message, not with a rotation failure.
