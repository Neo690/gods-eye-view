- **Every Windows, Android and iOS release now carries its own provenance.**
  The three publishers write `provenance.json` beside the installer, APK or IPA:
  the full commit and version from the release notes, the bundle's name, size
  and SHA-256, and the digest and component count of `sbom.cdx.json`. That SBOM
  is CycloneDX 1.5 and lists the production npm dependencies that ship with the
  shell, the packaged Electron version on Windows, and the release bundle as a
  file component carrying the same SHA-256. The published-assets gate downloads
  all three files and refuses a release whose manifest disagrees with its notes,
  whose bundle digest disagrees with the downloaded bytes, whose SBOM does not
  hash to the manifest, or whose SBOM names another commit, version or bundle.
  An iOS release without Apple signing can carry none of the three, because no
  run can rebuild or remove them.
