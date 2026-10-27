import Foundation

/// Serves `www/` out of the app bundle.
///
/// The folder reference keeps the build's own layout, so a request path is a
/// file path: `assets/index-abc.js` is `www/assets/index-abc.js`. Directory
/// traversal is refused rather than normalised, because a bundle read is not
/// where an interesting bug should be possible.
struct BundleAssets {
  private let root: URL?
  private static let indexFile = "index.html"

  init(bundle: Bundle = .main) {
    root = bundle.resourceURL?.appendingPathComponent("www", isDirectory: true)
  }

  var isPresent: Bool {
    guard let root else { return false }
    return FileManager.default.fileExists(
      atPath: root.appendingPathComponent(Self.indexFile).path
    )
  }

  func response(for rawPath: String) -> HTTPResponse {
    guard let root else {
      return .text(503, "The console bundle is missing from this build.")
    }
    var path = rawPath.removingPercentEncoding ?? rawPath
    if path.isEmpty || path == "/" { path = "/" + Self.indexFile }
    if path.hasSuffix("/") { path += Self.indexFile }

    let relative = String(path.dropFirst())
    let segments = relative.split(separator: "/")
    if segments.contains("..") || relative.hasPrefix("/") {
      return .text(400, "Bad Request")
    }

    let url = root.appendingPathComponent(relative)
    guard let data = try? Data(contentsOf: url) else {
      return .text(404, "Not Found")
    }
    return HTTPResponse(
      status: 200,
      headers: ["Content-Type": Self.mimeType(for: relative)],
      body: data
    )
  }

  /// Mirrors the APK's table, including the wasm and glTF entries Cesium and
  /// the bundled tilesets need.
  static func mimeType(for path: String) -> String {
    let lower = path.lowercased()
    let table: [(String, String)] = [
      (".html", "text/html; charset=utf-8"),
      (".htm", "text/html; charset=utf-8"),
      (".js", "application/javascript; charset=utf-8"),
      (".mjs", "application/javascript; charset=utf-8"),
      (".css", "text/css; charset=utf-8"),
      (".json", "application/json; charset=utf-8"),
      (".geojsonl", "application/jsonl; charset=utf-8"),
      (".svg", "image/svg+xml"),
      (".png", "image/png"),
      (".jpg", "image/jpeg"),
      (".jpeg", "image/jpeg"),
      (".webp", "image/webp"),
      (".gif", "image/gif"),
      (".ico", "image/x-icon"),
      (".wasm", "application/wasm"),
      (".glb", "model/gltf-binary"),
      (".gltf", "model/gltf+json"),
      (".woff2", "font/woff2"),
      (".woff", "font/woff"),
      (".ttf", "font/ttf"),
      (".xml", "application/xml"),
      (".txt", "text/plain; charset=utf-8"),
      (".csv", "text/plain; charset=utf-8"),
      (".mp4", "video/mp4"),
      (".mp3", "audio/mpeg"),
    ]
    for (suffix, mime) in table where lower.hasSuffix(suffix) {
      return mime
    }
    return "application/octet-stream"
  }
}
