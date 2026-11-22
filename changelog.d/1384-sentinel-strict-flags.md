- **The Sentinel gate no longer accepts a typo as a default.** Its command line
  is read strictly now: an unknown argument, a repeated flag or a flag with no
  value exits 2 with the usage line instead of being ignored. `--urll <url>`
  used to fall through to `http://localhost:4173`, so a mistyped address could
  run the whole gate against a different server and pass for the wrong reason;
  `--url` with an empty value is refused for the same reason. `--case` keeps its
  own message when the value is empty but valid — an empty name is still no boot
  at all — and the `--self-check`/`--case` conflict still exits 2.
