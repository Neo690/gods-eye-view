- Resolve CCTV specs by dataset id before the feed's spelling: every vendored
  record's `id` is already its cctv-camera-database row id, so a camera the
  catalog join confirmed (`modelRef`) now finds its datasheet through
  `specByDatasetRef` without re-reading the source's `model` string — a verbose
  registry title, a relocated vendor name, or an unrecognisable string no longer
  matters once the row is known. The word matcher stays as the fallback, so
  seeds and hand-authored sources (a model but no confirmed ref) resolve exactly
  as before, and an id this module does not vendor falls through to it instead
  of resolving nothing. Tests pin all 17 vendored refs against the committed
  snapshot, the ref-over-words priority, the unvendored fallback, and the catalog
  path that fills a spec from a ref whose string alone would never match.
