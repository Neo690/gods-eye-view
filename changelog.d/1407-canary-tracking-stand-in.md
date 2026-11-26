- The live layer canary's tracking step — the issue it creates, rewrites and
  comments on — is now exercised locally instead of assumed. `applyTracking` and
  `loadTracking` take their `gh` runner as an argument, `CANARY_GH` points that
  runner at a stand-in, and `scripts/fixtures/live-layer-canary/fake-gh.mjs`
  implements just the gh commands the step uses against a JSON issue world it
  records a transcript of. A run can therefore be replayed end to end —
  `CANARY_GH=… FAKE_GH_STATE=… GH_TOKEN=local node scripts/live-layer-canary.mjs
  report --keyless report.json` — and the tests assert the exact call sequence
  for a first failure, a repeat failure, a recovery and the guards that keep a
  skipped or dry run out of the history. The stand-in refuses any command it does
  not model, so a new gh call cannot slip in unexercised.
- Found by that exercise: the tracking lookup listed only open issues, so a
  tracker someone closed by hand was invisible. The next run created a second
  issue, splitting the history and resetting the streaks. It now lists closed
  trackers too, prefers the open one, continues the newest by issue number
  rather than whatever order the lookup returned, and reopens the closed one
  when there is something to say.
