- The **Plate Reader** reuses its last answer when the camera republishes the
  same bytes, instead of running the detector again over pixels it has already
  read: identical pixels cannot mean a different plate. The window is explicit
  and bounded — **one minute from the read that actually looked**, never renewed
  by a reuse, so a frozen camera is still read again a minute later, and beyond
  it the answer is recomputed. The row says `Same frame · 42s` rather than
  letting a minute-old read look fresh, the response carries `reusedFrame` and
  `ageMs` beside the existing `retention: "none"` and the new `frameReuseMs`, and
  nothing is written anywhere: the entry lives in the process and is dropped with
  it.
