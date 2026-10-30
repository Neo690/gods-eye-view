- Publish an ad-hoc `.ipa` from CI: the `iOS app` workflow now archives the
  shell, exports it for the devices a provisioning profile names, checks the
  console, the bundle identifier, the signature and the embedded profile, and
  ships it as `gods-eye-view.ipa` in an `ios-latest` release. With no Apple
  signing secrets in the repository the packaging job skips instead of failing,
  and the shell still compiles (Neo690, #4).
