- **One wording for a lost rotation.** The rotation assertion and the
  `--self-check` that proves it can still fail each carried their own copy of
  the failure message, so reformulating the assertion would have turned the
  self-check red for no reason — the exact false alarm the mode exists to rule
  out. `ROTATION_FAILURE` is now the only copy: the assertion fails with it and
  the self-check looks for that same string in the failure it produced.
