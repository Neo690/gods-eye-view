- Four defects the release audit found in the suite itself, each of which made a
  real check unrunnable or untrue. The reference-factory contract now names the
  three layers that joined it — `orbit-changes`, `satellite-watch` and
  `fishing-effort` — so it again asserts the whole catalogue instead of failing
  on the first added source. The sky-asset probe reads its cube faces through
  `fileURLToPath`, because `URL.pathname` yields `/C:/…` on Windows and sharp
  reported a missing file that was there. The unit-test discovery walk skips
  `desktop/release`, electron-builder's output, which carries a copy of every
  test file inside the packaged app and made the "every test file is executed"
  check unpassable after any Windows build. And the Realtime prompt is back under
  its 52,000-character ceiling: two sentences carrying the same rule as a
  neighbouring one were tightened, rather than raising a budget that exists to
  keep a new tool or rule from being paid for by the old ones.
