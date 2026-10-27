import Foundation
import Network

/// One parsed request. The shell needs very little of HTTP: a method, a path
/// with its query, the headers it cares about, and a body for the two POST
/// routes the page calls.
struct HTTPRequest {
  let method: String
  let path: String
  let query: String
  let headers: [String: String]
  let body: Data
}

struct HTTPResponse {
  var status: Int
  var headers: [String: String]
  var body: Data

  static func json(_ status: Int, _ object: [String: String]) -> HTTPResponse {
    let data =
      (try? JSONSerialization.data(withJSONObject: object, options: []))
      ?? Data("{}".utf8)
    return HTTPResponse(
      status: status,
      headers: ["Content-Type": "application/json; charset=utf-8"],
      body: data
    )
  }

  static func text(_ status: Int, _ body: String) -> HTTPResponse {
    HTTPResponse(
      status: status,
      headers: ["Content-Type": "text/plain; charset=utf-8"],
      body: Data(body.utf8)
    )
  }
}

/// Serves the bundled console from `http://127.0.0.1:<port>/`.
///
/// A loopback origin is the whole point. WebKit only grants geolocation,
/// `getUserMedia`, workers and IndexedDB on a secure context, and the Secure
/// Contexts standard treats `127.0.0.1` as potentially trustworthy while it
/// makes no such promise for an arbitrary custom scheme. Serving the build
/// here also keeps `/api/*` same-origin, with no CORS and no second origin to
/// reason about.
///
/// The port is FIXED on purpose: `localStorage` — where Provider Settings keeps
/// the operator's keys — is keyed by origin, so a port that moved between
/// launches would silently lose every saved key.
final class LocalServer {
  static let port: UInt16 = 47821

  private let assets: BundleAssets
  private let forwarder: ApiForwarder
  private var listener: NWListener?
  private let queue = DispatchQueue(label: "com.godseye.view.server")

  init(assets: BundleAssets, forwarder: ApiForwarder) {
    self.assets = assets
    self.forwarder = forwarder
  }

  var origin: URL? {
    var components = URLComponents()
    components.scheme = "http"
    components.host = "127.0.0.1"
    components.port = Int(Self.port)
    return components.url
  }

  var startURL: URL? {
    origin?.appendingPathComponent("index.html")
  }

  /// Bind the listener. Throws when the port is taken — a second copy of the
  /// app, or something else already holding it — because that is a condition
  /// the operator has to act on, not something to paper over with a new port.
  func start() throws {
    stop()
    let port = NWEndpoint.Port(rawValue: Self.port)!
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    // Loopback only: the bundle and the operator's keys never leave the device.
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
    let listener = try NWListener(using: parameters, on: port)
    listener.newConnectionHandler = { [weak self] connection in
      self?.handle(connection)
    }
    listener.stateUpdateHandler = { state in
      if case let .failed(error) = state {
        NSLog("[GodsEyeView] listener failed: \(error)")
      }
    }
    listener.start(queue: queue)
    self.listener = listener
  }

  func stop() {
    listener?.cancel()
    listener = nil
  }

  private func handle(_ connection: NWConnection) {
    connection.start(queue: queue)
    read(connection, buffer: Data())
  }

  /// Accumulate until the head arrives, then until the declared body is here.
  private func read(_ connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
      [weak self] chunk, _, isComplete, error in
      guard let self else { return }
      var accumulated = buffer
      if let chunk { accumulated.append(chunk) }

      if error != nil {
        connection.cancel()
        return
      }

      switch self.parse(accumulated) {
      case .incomplete:
        if isComplete {
          connection.cancel()
          return
        }
        self.read(connection, buffer: accumulated)
      case .invalid:
        self.respond(connection, HTTPResponse.text(400, "Bad Request"))
      case let .complete(request):
        Task { [weak self] in
          guard let self else { return }
          let response = await self.route(request)
          self.respond(connection, response, headOnly: request.method == "HEAD")
        }
      }
    }
  }

  private enum ParseResult {
    case incomplete
    case invalid
    case complete(HTTPRequest)
  }

  private func parse(_ data: Data) -> ParseResult {
    guard let headEnd = data.range(of: Data("\r\n\r\n".utf8)) else {
      return data.count > 32 * 1024 ? .invalid : .incomplete
    }
    let headText =
      String(data: data[..<headEnd.lowerBound], encoding: .utf8) ?? ""
    let lines = headText.components(separatedBy: "\r\n")
    guard let requestLine = lines.first else { return .invalid }
    let parts = requestLine.split(separator: " ")
    guard parts.count >= 2 else { return .invalid }

    let method = String(parts[0]).uppercased()
    let target = String(parts[1])
    guard target.hasPrefix("/") else { return .invalid }

    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      guard let colon = line.firstIndex(of: ":") else { continue }
      let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
      let value = line[line.index(after: colon)...]
        .trimmingCharacters(in: .whitespaces)
      headers[name] = value
    }

    let declaredLength = Int(headers["content-length"] ?? "0") ?? 0
    let available = data.count - headEnd.upperBound
    if available < declaredLength { return .incomplete }
    if declaredLength > 8 * 1024 * 1024 { return .invalid }

    let body = data[headEnd.upperBound..<(headEnd.upperBound + declaredLength)]
    var path = target
    var query = ""
    if let mark = target.firstIndex(of: "?") {
      path = String(target[..<mark])
      query = String(target[target.index(after: mark)...])
    }
    return .complete(
      HTTPRequest(
        method: method,
        path: path,
        query: query,
        headers: headers,
        body: Data(body)
      )
    )
  }

  private func route(_ request: HTTPRequest) async -> HTTPResponse {
    if request.path == "/api" || request.path.hasPrefix("/api/") {
      return await forwarder.handle(request)
    }
    if request.method != "GET" && request.method != "HEAD" {
      return .text(405, "Method Not Allowed")
    }
    return assets.response(for: request.path)
  }

  private func respond(
    _ connection: NWConnection,
    _ response: HTTPResponse,
    headOnly: Bool = false
  ) {
    var headers = response.headers
    headers["Content-Length"] = String(response.body.count)
    headers["Cache-Control"] = headers["Cache-Control"] ?? "no-cache"
    // No keep-alive: the console opens what it needs and the socket is cheap
    // on loopback, while a half-read idle connection is not.
    headers["Connection"] = "close"

    var head = "HTTP/1.1 \(response.status) \(Self.reason(response.status))\r\n"
    for (name, value) in headers.sorted(by: { $0.key < $1.key }) {
      head += "\(name): \(value)\r\n"
    }
    head += "\r\n"

    var payload = Data(head.utf8)
    if !headOnly { payload.append(response.body) }
    connection.send(
      content: payload,
      completion: .contentProcessed { _ in connection.cancel() }
    )
  }

  private static func reason(_ status: Int) -> String {
    switch status {
    case 200: return "OK"
    case 204: return "No Content"
    case 304: return "Not Modified"
    case 400: return "Bad Request"
    case 404: return "Not Found"
    case 405: return "Method Not Allowed"
    case 501: return "Not Implemented"
    case 502: return "Bad Gateway"
    case 503: return "Service Unavailable"
    default: return "Status \(status)"
    }
  }
}
