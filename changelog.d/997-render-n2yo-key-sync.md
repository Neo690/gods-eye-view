- The deployed `/api/n2yo/above` route is no longer keyless. The Render
  blueprint declares `N2YO_API_KEY` (`sync: false`, so no secret is committed),
  and the deploy workflow now pushes its value from a repository secret of the
  same name onto the service before it asks for a deploy — idempotently, and
  only when the deployed value differs. A fresh service or a rotated key
  therefore needs no dashboard trip. The same run ends by calling the route
  once: a `200` proves the key is live, a `503` is reported as a warning
  because that source degrades instead of failing the app.
