import Foundation

/// Build inputs. Written by `scripts/prepare-ios-payload.mjs`; the committed
/// copy is the standalone one (no data server).
///
/// The Cesium ion token and the Google Maps key are deliberately absent: Vite
/// inlines them into `www/` at build time, the same way the APK gets them.
enum BuildConfig {
  /// Origin of a hosted copy of this repository, e.g. `https://gev.example.com`.
  /// Empty means "no server": the shell answers `/api/*` with a JSON 503 that
  /// names the missing configuration, and every live layer reports it.
  static let apiBase = ""
}
