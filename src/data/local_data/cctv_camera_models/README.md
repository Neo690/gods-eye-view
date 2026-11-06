# CCTV camera models

A brand/model lookup built from [ch-bas/cctv-camera-database](https://github.com/ch-bas/cctv-camera-database)'s public CSV — 29k+ CCTV/IP camera models across 235 brands, each transcribed upstream from a manufacturer datasheet, **CC0-licensed** (public domain: reused here with no restrictions).

Runtime output: `cctv_camera_models.json`

```
{
  "schemaVersion": 1,
  "source": "ch-bas/cctv-camera-database",
  "license": "CC0-1.0",
  "generatedAt": "<ISO>",
  "cameraCount": 29582,           // rows consumed from the upstream CSV
  "brandCount": 235,
  "brands": ["2N", ...],           // canonical spelling
  "brandNorm": ["2n", ...],        // lowercase, for peeling brand prefixes
  "lookup": {
    "<normalized model key>": [
      { "brand": "Cohu", "model": "3960", "id": "cohu-3960" }
    ]
  }
}
```

Lookup keys are the upstream model text lowercased with every non-alphanumeric
run collapsed to one space; when the model starts with the brand, the prefix-
stripped text is keyed too (Axis P1346 answers for both `axis p1346` and
`p1346`). A key held by rows from more than one camera id stays in the file
but confirms nothing at match time.

## What the runtime does with it

`server/providers/cctv/cameraDb.js` reads only this file — the dataset repo is
never contacted at runtime. `joinCameraModels` runs on the freshly assembled
catalog (see `server/providers/cctv/catalog.js`) and touches a source only
when the feed itself published a hardware `model` string (today: King County;
curated `file`/`env` entries may too):

- a confirmed match **fills a missing `manufacturer`** (from the dataset's
  brand) and attaches `modelRef` (dataset row id) and `modelMatch`
  (`exact` = full model string, brand prefix peeled; `series` = a series
  number naming one longer upstream title, `3950` → `3950 iVIEW`);
- everything the pack published — including its own `model` text and any
  `manufacturer` it already set — is left exactly as the feed wrote it. The
  join adds traceability; it never corrects or invents.

A feed with no `model` field is untouched: camera place names never match.

## Regenerate

```
node scripts/build-cctv-camera-models.mjs                 # fetches the live CSV
node scripts/build-cctv-camera-models.mjs --csv data.csv  # or a local copy
```
