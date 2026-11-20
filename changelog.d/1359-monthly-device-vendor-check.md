- The Device Sweep shortlist is re-checked against the IEEE registries by a
  monthly scheduled workflow. `scripts/check-device-vendors.mjs` already exits
  non-zero on a prefix that is no longer an MA-L block or whose registered
  company no longer matches, but it needs the public registries, so it stays out
  of pull-request CI where a network hiccup would become a red pipeline. The
  scheduled run needs no dependency install — the script imports one source
  module and reads three CSVs — and a failure mails the maintainers, so a table
  nobody edits is still looked at (Neo690, #1359).
