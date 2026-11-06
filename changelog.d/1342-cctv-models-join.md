The CCTV catalogue names its hardware from the open dataset instead of trusting
the feed's spelling alone.

- Sources whose feed publishes a hardware `model` (King County is the only live
  pack; curated `file`/`env` entries may too) are joined at catalog assembly
  against a vendored extract of the CC0 [ch-bas/cctv-camera-database](https://github.com/ch-bas/cctv-camera-database)
  dataset (29,582 models, 235 brands, transcription-first per its own rules).
  The extract is the committed `cctv_camera_models/cctv_camera_models.json`
  (brand/model/id + first-series-token map), rebuilt offline by
  `scripts/build-cctv-camera-models.mjs`; the runtime never fetches it.
- The join fills only what a feed left unsaid: a missing `manufacturer` (from the
  dataset's brand) plus the traceability fields `modelRef` (dataset row id) and
  `modelMatch` (`exact` after a known brand prefix is peeled, `series` when a
  bare numbering "3950" names the one dataset title "3950 iVIEW"). A string that
  names a brand is refused when the resolved row is another maker's hardware,
  an ambiguous model key ("Duplex" under two brands) confirms nothing, and everything
  the feed published — its own `model` text, any `manufacturer` it set — is left
  as written. No endpoint, stream path or access config ever enters the index:
  the extract carries hardware identities only, same scope guardrail as the
  client-side spec extract in [modelSpecs.js](src/layers/cctv/modelSpecs.js).
  Curated `file`/`env` entries get the same treatment via `/api/cctv/sources`.
