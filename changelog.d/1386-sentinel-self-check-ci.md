- **Every CI run now proves the Sentinel gate can still fail.** The
  `--self-check` mode runs as its own step in the browser job, right after the
  Sentinel rotation gate, with its own id and a six-minute budget: it reuses the
  same Chrome, build and preview server, and it is keyed to the Sentinel step,
  so a Sentinel failure still gets its assertions checked. The job cap rose to
  42 minutes so two 12-minute gates, this one and the setup all fit inside it.
  The evidence archives are untouched: the self-check adds no upload, and a run
  of it that fails leaves its pages in the same `qa-artifacts/` tree the gate
  already ships.
