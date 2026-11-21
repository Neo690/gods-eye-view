- **Device Sweep** no longer writes a scan that is not the operator's own. The
  store keeps every device it already has and greys the ones the latest scan no
  longer sees, so a file from another network used to mute a whole sweep and add
  a stranger's devices around the operator's own place, silently. A picked file
  that names less than a quarter of the stored sweep is now read and held: the
  row asks "Only 0 of your 4 devices are in this file. Import it anyway? Your
  scan would stay, greyed, and this one would be added to it.", the import chip
  becomes IMPORT ANYWAY, and a CANCEL chip drops the file. Nothing is written
  until the answer, and the held file is the one that was read, so the operator
  never picks it twice.
- The line is a share of what is stored, not a fixed count: a re-scan of the
  same network names nearly all of it and goes straight in, a first import has
  nothing to contradict and is never questioned, and a file that names none of
  the sweep is exactly the case the guard exists for. A quarter is the floor.
- Any other action in the row — a place from a fix, a globe click, typed
  coordinates, a note, a clear — drops the held file, so a question left open
  cannot be answered by a later press of the chip that asked it.
