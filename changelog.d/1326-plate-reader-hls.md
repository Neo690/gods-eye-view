- Read plates from **video-only cameras**. DelDOT's live cameras publish HLS
  video and no still image, so the frame route answered `frame-unavailable`
  for all of them and the Plate Reader had nothing to look at. The server now
  has a HLS frame reader: it asks the stream the CCTV panel is probably
  already pulling (the shared buffered puller; a cold camera is warmed to its
  first key frames before the reader is answered) and puts the newest buffered
  MPEG-TS segment through a single `ffmpeg` invocation that skips to the first
  H.264 keyframe and hands the JPEG straight back on a pipe — no still URL, no
  disk output, no more than one bounded decode per segment and at most two
  buffered segments tried per read. If a segment starts mid-GOP and offers no
  keyframe, the previous one is read instead; if ffmpeg is not installed
  (an optional dependency) the route keeps its `frame-unavailable` contract
  and says so once instead of per read (yourname, #1326).
