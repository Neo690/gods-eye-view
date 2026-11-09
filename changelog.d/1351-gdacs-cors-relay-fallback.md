- The **Global disasters** layer reaches GDACS again. The upstream
  `gdacs.org` events API stopped sending an `Access-Control-Allow-Origin`
  header, so every browser-direct read of it died with "Failed to fetch" - on
  the desktop console and inside the Android shell alike. The page read now
  attempts the direct fetch first and, when the fetch itself rejects, retries
  the same document through the app's own `/api/upstream` relay: the Node
  server pins the GDACS SEARCH route by origin and path (only the paging
  query moves) and the Android shell adds `www.gdacs.org` to its allow-listed
  upstream hosts. A relay failure fails the snapshot exactly as the direct
  read did; an origin that still serves CORS never touches the relay.
