- The **Plate Reader** now builds its two ONNX sessions at boot instead of on
  the first read. Creating them reads 11 MB of weights: measured at ~0.85 s of
  the first read's 1.0 s on a workstation, and ~3.8 s of the 7.2 s a hosted read
  took on the free instance. The same read answers in ~0.2 s locally once the
  sessions exist, so the first read no longer pays for them; the peak memory is
  unchanged, because that read would have loaded them anyway. A missing model
  set is still the route's 503 with `npm run alpr:models`, not a boot failure.
