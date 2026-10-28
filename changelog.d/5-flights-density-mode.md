- Add a Density mode to the flights layer: one button refetches the 250 nm
  around the view every 5 seconds instead of waiting out the 30-second worldwide
  poll, and shortens the display delay to match, so the contacts on screen are
  seconds old rather than a poll. Measured over Paris, the mean position age fell
  from 31.6 s to 1.9 s for a sixteenth of the bandwidth. The local proxy caches
  each anchor for 5 s, shares one upstream read per second between viewers, and
  backs off 5 s doubling to 60 s; a failed patch serves the last good one, then
  the cached worldwide snapshot, so the layer never empties. It ships off and is
  never restored from a saved session or a share link, because it spends a
  volunteer network's rate limit (Neo690, #5).
