- The Android shell now **declares `/api/fishing-effort`** instead of leaving it
  to the asset store. It cannot answer it — the Global Fishing Watch token is
  server-side by design, because the report endpoint runs one report per token
  at a time — so it answers the same `503 {"error":"no_key"}` the server does
  when the key is unset. That matters because the rescue path accepts any answer
  under 500: the route's previous 404 was re-served in place of the server's
  honest 503, and the layer reported "Fishing effort HTTP 404" — a wrong reason
  that hid the real one. A 5xx leaves the server's own answer (200 with the
  token, 503 without it) in place.
- `GFW_API_TOKEN` is now **declared in the Render blueprint and synced by the
  deploy workflow**, exactly like the N2YO and Space-Track accounts: adding the
  repository secret is enough for the next deploy to push it, with no dashboard
  trip and no value in the tree. Unset, the route keeps answering
  `{"error":"no_key"}` and only the Fishing Effort layer reports a missing key.
