import Foundation

/// Replays the console's `/api/*` calls on a hosted copy of this repository.
///
/// The layers that carry live data ask their own origin for `/api/...`; the
/// desktop answers them from the Vite middleware in `server/`. A phone has no
/// Node process, so with `BuildConfig.apiBase` set the request is re-issued
/// here instead, over the network, exactly as `ApiForwarder` does in the APK.
///
/// Requests leave from the app, not from the page, so the server's source gate
/// sees no browser `Origin` and no CORS preflight is involved. The base must be
/// HTTPS: ATS allows only the loopback origin over plain HTTP.
struct ApiForwarder {
  private let base: URL?

  init(configuredBase: String) {
    var trimmed = configuredBase.trimmingCharacters(in: .whitespacesAndNewlines)
    while trimmed.hasSuffix("/") { trimmed.removeLast() }
    guard !trimmed.isEmpty, let url = URL(string: trimmed) else {
      base = nil
      return
    }
    base = url
  }

  var isEnabled: Bool { base != nil }

  var describe: String { base?.absoluteString ?? "in-app (no data server)" }

  /// Headers that describe the WebView rather than the server call.
  private static let droppedRequestHeaders: Set<String> = [
    "host", "origin", "referer", "cookie", "connection", "keep-alive",
    "accept-encoding", "content-length", "upgrade-insecure-requests",
  ]

  func handle(_ request: HTTPRequest) async -> HTTPResponse {
    if request.method == "OPTIONS" {
      return HTTPResponse(status: 204, headers: [:], body: Data())
    }
    guard let base else {
      // No data server in this build: say so once, in JSON, so a layer shows
      // "unavailable" instead of a puzzling 404 from the asset store.
      return .json(503, [
        "error": "no_server",
        "detail":
          "This build has no data server. Set GEV_API_BASE when packaging, or deploy edge-api/.",
      ])
    }
    if request.method != "GET" && request.method != "HEAD" && request.method != "POST" {
      return .json(501, [
        "error": "not_implemented",
        "detail": "The shell replays GET, HEAD and POST only; \(request.method) needs the project's own server.",
      ])
    }

    var components = URLComponents(
      url: base.appendingPathComponent(String(request.path.dropFirst())),
      resolvingAgainstBaseURL: false
    )
    if !request.query.isEmpty {
      components?.percentEncodedQuery = request.query
    }
    guard let target = components?.url else {
      return .json(400, ["error": "bad_request"])
    }

    var urlRequest = URLRequest(url: target)
    urlRequest.httpMethod = request.method
    urlRequest.timeoutInterval = 20
    urlRequest.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
    for (name, value) in request.headers {
      if Self.droppedRequestHeaders.contains(name) { continue }
      if name.hasPrefix("sec-fetch-") || name.hasPrefix("proxy-") { continue }
      urlRequest.setValue(value, forHTTPHeaderField: name)
    }
    if request.method == "POST", !request.body.isEmpty {
      urlRequest.httpBody = request.body
      urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }

    do {
      let (data, response) = try await URLSession.shared.data(for: urlRequest)
      let http = response as? HTTPURLResponse
      let status = http?.statusCode ?? 502
      var headers: [String: String] = [:]
      if let contentType = http?.value(forHTTPHeaderField: "Content-Type") {
        headers["Content-Type"] = contentType
      }
      // A rate-limited server is the server's address problem, not this
      // build's: pass it through with its status so the shell can fall back the
      // way the APK does.
      return HTTPResponse(status: status, headers: headers, body: data)
    } catch {
      return .json(502, [
        "error": "upstream_failure",
        "detail": "Could not reach the data server at \(base.absoluteString) (\(error.localizedDescription)).",
      ])
    }
  }
}
