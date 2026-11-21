- **Device Sweep**'s inventory is a list under its row, not only markers on the
  globe. A Cesium point answers the mouse and nothing else, so the sweep used to
  be unreadable to a keyboard and unreachable to a thumb: the row now carries one
  real `<button>` per device — inside its `<li>`, so Tab reaches it and Enter
  activates it — in the ring's own order. Each entry names the address first,
  then the maker, the verdict, the open ports and the age, and says `Not in your
  last scan` for a device the latest import left out. The list is a `<ul>`: the
  devices are a set, not a numbered route, even though the ring ranks the
  flagged ones first.
- Enter on an entry flies the camera to that device's slot on the ring and says
  `Centered on <address>` in the row's line, so the schematic position the
  marker holds is reachable without hunting a point on the globe. The ring and
  the list share one ordering (`orderedSweepDevices`), so the entry pressed is
  the marker that was being looked at, and the point cap can never drop a live
  device in favour of a quiet one. Any other row action still drops a
  held-back import question, as before (Neo690, #1368).
