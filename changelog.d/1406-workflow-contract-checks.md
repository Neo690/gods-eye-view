- **Lint the workflows and check their internal references.** CI now runs
  `actionlint` over every workflow — a pinned release binary verified against a
  recorded checksum rather than an npm dependency — and a new unit test resolves
  each `needs.<job>.outputs.<name>` and `steps.<id>` reference against the jobs
  and steps that exist. A renamed output fails in CI instead of at the moment a
  canary step needs it.
