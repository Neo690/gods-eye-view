- Read the **Plate Reader**'s frame in overlapping tiles instead of one
  downscaled pass, so a plate on a wide camera survives. A 1280×720 still was
  shrunk to 0.3 before the detector ever saw it, which erased anything past a
  few dozen metres; it is now cut into native-resolution 384 px tiles (one per
  detector run, nine at most, the whole frame still read once for a car close
  to the lens) and the boxes are merged before OCR, so a car is one answer and
  a box cut by a tile edge — the `13C` a seam used to produce — is dropped
  rather  than reported as a registration. Tiling also makes the detector fire on what
  the downscale used to blur away — a station label came back as `T_F17` at
  0.21, a road marking as `1FF849` at 0.36, and a green street sign as
  `COI0T0Q00T` at 0.66 — so a reading is only called a plate above half the
  OCR's confidence and inside the four-to-nine characters a registration can
  have.
  Measured on a synthetic 1280×720 frame whose plate is invisible to the
  single pass, the tiled read returns it at 0.99 confidence, for about 0.4 s of
  detector time instead of 0.05 s (yourname, #1323).
