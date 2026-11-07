- New opt-in CCTV pack for **Illinois**: the Illinois DOT Gateway layer behind
  Travel Midwest, declared CC BY-SA 2.0. The layer pages at 1,000 features over
  ~3,800, so the loader walks it four pages deep and keeps the 2,212 cameras
  whose frames sit on the programme host `cctv.travelmidwest.com/snapshots/`;
  1,577 Lake County PASSAGE cameras in the same layer point at a partner
  agency's own host, outside the layer's licence declaration, and are skipped.
  One feature is one camera view, so an intersection with
  three directions is three records, each named with its direction — and that
  direction letter becomes the camera's bearing at high confidence instead of
  the usual id-hash prior, which still covers the views the layer marks `NONE`.
  Frames the upstream has stopped refreshing (`TooOld`) are dropped rather than
  shown as current. Because the licence adds ShareAlike to attribution, the
  pack loads only with `CCTV_ILLINOIS_ENABLED=1`; `CCTV_ILLINOIS_MAX_SOURCES`
  (default 400, nearest Chicago, Springfield, Peoria, Rockford and Urbana first)
  and `CCTV_ILLINOIS_CAMERAS_URL` tune it. Tests pin the feature parse, the
  direction mapping and its low-confidence fallback, the `TooOld` and foreign
  host refusals, the bbox, the paging walk, the cap ordering, the redirect
  refusal and both sides of the opt-in.
