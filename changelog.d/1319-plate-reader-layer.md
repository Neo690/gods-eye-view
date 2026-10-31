- A new **Plate Reader** row (`plate-reader`) reads the plates visible in the
  still frame of the **CCTV camera currently selected** on the map. It is a
  port of `fast-alpr` to this server's runtime: the same YOLOv9 plate detector
  and the same CCT global OCR, run through `onnxruntime-node` on the host, so
  the browser sends a camera id and receives plate strings instead of shipping
  a model to the client. `server/alpr/` holds the letterbox geometry and the
  YOLOv9 row decoding, the plate-config parser and the per-slot argmax, all
  pure and unit-tested (including the exact box the reference image yields);
  `POST /api/alpr` serves one camera at a time, refuses anything but POST and
  a same-site caller, names only cameras the server already knows — never a
  client URL — and answers 404/409/503 (`npm run alpr:models`) rather than a
  blank result. Nothing is stored: the text lives in the layer's closure and
  the server keeps an answer for eight seconds to absorb a redraw, no plate is
  written to layer state, a share link or the log. The weights are not
  committed; `npm run alpr:models` fetches them with a pinned SHA-256, and the
  hosted image runs it at build time, because the upstream packages download
  their own weights from a mutable release tag with no check at all.
