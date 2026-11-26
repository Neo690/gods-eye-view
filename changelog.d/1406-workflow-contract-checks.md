- **Lint the workflows.** CI now runs `actionlint` over every workflow — a pinned
  release binary verified against a recorded checksum rather than an npm
  dependency. It reads the workflows against the real Actions schema, so a
  `needs.<job>.outputs.<name>` that no job declares, a `steps.<id>` that no step
  defines or a renamed job fails in CI instead of at the moment a canary step
  needs it.
