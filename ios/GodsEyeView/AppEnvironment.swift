import Foundation

enum StartupError: LocalizedError {
  case bundleMissing
  case noOrigin

  var errorDescription: String? {
    switch self {
    case .bundleMissing:
      return """
      The console bundle is missing from this build.

      Run `npm run build`, then `npm run ios:payload`, and rebuild the app in Xcode.
      """
    case .noOrigin:
      return "The local origin could not be built. This is a bug in the shell; please report it."
    }
  }
}

/// The shell's three moving parts, in the order they depend on each other:
/// assets out of the bundle, `/api/*` replayed against a data server (when the
/// build was given one), and both of those served on `127.0.0.1`.
///
/// Keeping it in one object is what lets the app stop serving when it is
/// backgrounded and start again on return: iOS can reclaim the socket while the
/// process is suspended, and a page that outlives its origin would fail every
/// fetch afterwards.
final class AppEnvironment {
  let assets: BundleAssets
  let forwarder: ApiForwarder
  let server: LocalServer

  private(set) var isServing = false

  init(bundle: Bundle = .main, apiBase: String = BuildConfig.apiBase) {
    let assets = BundleAssets(bundle: bundle)
    let forwarder = ApiForwarder(configuredBase: apiBase)
    self.assets = assets
    self.forwarder = forwarder
    self.server = LocalServer(assets: assets, forwarder: forwarder)
  }

  /// What the data-server setting resolved to, short enough for a line of the
  /// device log and for the startup failure alert.
  var dataServerDescription: String { forwarder.describe }

  /// `true` when the build can reach live feeds at all.
  var hasDataServer: Bool { forwarder.isEnabled }

  /// Bind the listener and hand back the page to load.
  func start() throws -> URL {
    guard assets.isPresent else { throw StartupError.bundleMissing }
    try server.start()
    guard let url = server.startURL else { throw StartupError.noOrigin }
    isServing = true
    NSLog("[GodsEyeView] serving \(url.absoluteString) — data server: \(dataServerDescription)")
    return url
  }

  func stop() {
    server.stop()
    isServing = false
  }

  /// Restart after returning from the background. The page is already loaded, so
  /// nothing is reloaded: only the origin it talks to is brought back.
  @discardableResult
  func ensureServing() -> Bool {
    if isServing { return true }
    do {
      _ = try start()
      return true
    } catch {
      NSLog("[GodsEyeView] could not resume serving: \(error.localizedDescription)")
      return false
    }
  }
}
