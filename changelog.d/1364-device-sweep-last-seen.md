- **Device Sweep** keeps the devices the latest scan did not answer for instead
  of dropping them. A camera that stops replying is the finding the operator
  asked for, and a re-import used to erase it: the store now records the last
  time each device was seen, a new file only stamps the devices it named, and
  the ring draws the rest in a dim grey with its own legend entry and a "Not in
  your last scan" line in the hover text. The row's summary counts them, their
  notes stay attached, and they are ordered behind the devices the scan did see
  so the point cap never truncates a live device in favour of a quiet one. The
  stored payload moves to v2 with `lastSeen` on each row; a v1 payload reads
  as-is, each device dated by the import that carried it, and is rewritten to
  v2 on the next import, so an upgraded browser greys nothing it has not
  actually missed (Neo690, #1364).
- The maker a stored scan reports is recomputed from the MAC on every read
  instead of being frozen at import time: the payload (now v3) keeps only the
  name the file itself gave, and the shortlist answers for the rest. Correcting
  the shortlist therefore corrects scans already imported — including taking a
  maker back when its prefix is withdrawn — instead of leaving a wrong maker
  printed on a device forever. A name the file carried is evidence and is kept
  as it stands (Neo690, #1364).
