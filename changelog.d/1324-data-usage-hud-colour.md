- Give the **data usage** line the telemetry window's own cyan instead of a
  washed-out white. It set `--text-primary` at 55 % opacity while MGRS, GSD and
  ALT beside it are the HUD's colour at full strength, so the rate read as a
  pale line under a glowing block; it now inherits the block's colour, size and
  tracking, and keeps its label at the same weight as `MGRS:` (yourname, #1324).
