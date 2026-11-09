- GhostMaps recovers from a rejected GitHub token. The public repository needs
  no credential, so a 401/403 on the authenticated tree or commit read is now
  retried once without `Authorization` before the catalog reports an error. A
  stale dashboard token no longer empties the S2 layer, while a genuine
  anonymous rate limit still reports its own 403 (Neo690, #1355).
