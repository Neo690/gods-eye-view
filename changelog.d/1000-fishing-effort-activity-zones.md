- Fishing Effort now draws **activity zones** over its cells: the dense cells are
  grouped and each group is outlined, so a fishing ground reads as a shape
  instead of a field of dots. Cells that share a side *or a corner* form one
  zone — a band is worked as a band — but only the cells above a share of the
  colour ceiling are grouped, so background effort cannot grow a
  coastline-wide outline, and a group of fewer than four cells is left to the
  dots. The contour is the true boundary of the union of the squares: an L-shape
  keeps its six corners, a zone with a hole keeps the hole as a second ring, and
  cells that meet only at a corner are drawn as the squares they occupy rather
  than the rectangle around the staircase, which would paint open water that
  carries no effort. Each zone gets a translucent fill scaled to its share of
  the strongest zone plus a bright outline, drawn above the cells; the row
  reports `Zones: n` so the count is readable without counting outlines by eye.
  `activityZones()` is pure and unit-tested (block, staircase band, L-shape,
  hole, ranking, threshold), and the layer exposes `zoneCount` in its stats.
