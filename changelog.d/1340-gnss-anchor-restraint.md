- Apply the **evidence-grade restraint** to the GNSS-integrity layer: only a
  top-band cell counts as anchor-grade evidence for a cross-layer reading, a
  machine-readable `anchor` flag on every cell and a `gnssProvenance.anchor`
  section (id `high-band-only`, defined by GEV, validated: false). Transient
  low accuracy reports are common coincidences in dense traffic, so a medium
  cell — however strong visually — is never promoted to evidence for anything
  outside the layer; the caution is worded on the high-band legend entry and
  pinned by tests (yourname, #1340).
