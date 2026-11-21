- **Device Sweep** now says how old a sweep is in words, not in clock time. A
  device's hover tip carries `Last seen: 3 days ago`, and the row carries
  `last import 3 days ago`, both built from `Intl.RelativeTimeFormat` through the
  app's own `formatRelativeTime`, so `yesterday`, `last month` and `last year`
  arrive in the reader's language instead of a date that has to be compared
  against today. The point is that a scan from three days ago must not read like
  one from this morning; the old readout left that comparison to the operator.
- Nothing under a minute is spoken: `now` is not an age, and an import or a
  sighting from the last minute is already the row's feedback line. A timestamp
  in the future — a clock that runs ahead — is treated the same way, and a
  missing `lastSeen` still adds no line at all.
- The stored payload is untouched: `lastSeen` and `importedAt` were already
  written, and this only changes how they are read out.
