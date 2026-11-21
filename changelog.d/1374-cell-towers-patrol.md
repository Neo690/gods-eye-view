- **Radio Sites now answers the Sentinel's walk.** The layer drew its ANFR
  towers and offered an analyst snapshot, but it did not expose
  `getAllPositions`, the method a patrol reads, so every fixed catalog was
  invisible while only moving layers carried the method. The layer now maps
  that snapshot to `{ latitude, longitude }`, preserving the caller's cap and
  returning nothing while hidden or destroyed. Its test covers the mapping,
  the cap and the empty state (Neo690, #1374).
