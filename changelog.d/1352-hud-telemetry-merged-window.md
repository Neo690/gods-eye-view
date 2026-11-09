- On a phone the HUD is **two floating windows**. The telemetry read was two
  separate slabs - the MGRS corner and the imaging-scale corner - laid out as
  separate glass over the map, while the fork's HUD windows are finger-
  draggable with a soft halo pool behind the text. The `hud-bottom-center`
  wrapper, which already held both corner blocks, becomes one merged window:
  the halo is drawn once on the wrapper, the drag spec moves the wrapper (id
  `telemetry`, replacing the old single-corner `bottom-left`), and the column
  sizes to its content beside the classification's centre line. Two windows
  in total: TOP SECRET up top, and merged MGRS + GSD telemetry above the
  credit band - each draggable, each memorizing where it was left.
