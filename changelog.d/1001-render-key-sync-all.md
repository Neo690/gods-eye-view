- The deploy workflow now keeps **every** server-only key on the Render service in
  step with a repository secret of the same name, not just the N2YO key: the
  allowed hosts, the Google, OpenAI, TomTom, AISStream, FIRMS, Overpass, Gemini,
  OpenSky pair, Space-Track pair and uRADMonitor pair join it. Same idempotent
  shape as before — read the deployed value, write only when it differs, fail
  the run only when Render refuses — plus a counter (`n key(s) written`) so a
  rotation is visible in the log. A key with no repository secret is no longer
  one warning per key: the missing names are collected and reported once, and
  those keys keep whatever the dashboard holds, so a half-configured service
  still deploys. The blueprint records the convention above `envVars`: a
  `sync: false` key means "pushed by the workflow", a `value:` key is not secret.
  Exercised locally against a stubbed Render API: unchanged values write
  nothing, a changed value writes once and reports 200, absent secrets yield a
  single warning and no write.
