- **The Windows shell installs its own updates.** The UPDATE panel used to open
  the Setup download in the system browser, so an installed copy could only move
  forward by finding the release page again. The shell now carries
  `electron-updater` behind a narrow preload bridge: the panel's own-platform
  button asks the main process to read the feed, downloads the published Setup
  with progress in the panel, and applies it with `quitAndInstall`, which
  restarts into the new build. The feed is generic and points at the rolling
  `desktop-latest` release, so no GitHub token or API quota is involved at
  update time; `latest.yml` and the block map are published after the exe they
  name. The installer keeps one stable asset name, since a version-stamped name
  would leave the stable download URL and the feed pointing at different files.
  A checkout, a non-Windows run or a missing feed reports that instead of
  failing silently, and the download starts only on the operator's request.
