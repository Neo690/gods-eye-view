import Foundation

/// The keyless `/api/*` routes, served inside the iOS app.
///
/// A standalone build has no Node process, so a layer that asks its own origin
/// for `/api/...` would reach `BundleAssets` and come back 404. The Android
/// shell answers those routes from `LiveApi.java`; this is the same surface for
/// iOS, plus `GET /api/upstream`, which the in-page API in
/// `src/data/inAppApi.js` uses for the feeds its own normalisers read.
///
/// Each route mirrors the contract of its counterpart in `server/`: same
/// upstream URL, same cache window, same headers the client already parses
/// (`x-tle-cache`, `x-opensky-cache`, `x-flight-source`, `x-flight-coverage`,
/// `x-military-sources`, `x-upstream-cache`).
///
/// Requests run in the app, not in the page, so no CORS applies and no browser
/// `Origin` is sent. Endpoints that need a credential — TomTom traffic, AIS
/// vessels, Global Fishing Watch — answer `503 {"error":"no_key"}` with the
/// route that needs it, so the layer reports a missing key instead of a bare
/// HTTP error. Nothing here ships or reads a server-side key: a public app
/// cannot keep one.
struct LiveApi {
  private static let userAgent =
    "gods-eye-view-ios-shell/1.0 (+https://github.com/Neo690/gods-eye-view)"

  private static let celestrakTTL: TimeInterval = 6 * 3600
  private static let flightsTTL: TimeInterval = 10
  private static let trackTTL: TimeInterval = 60
  private static let launchesTTL: TimeInterval = 15 * 60
  private static let militaryTTL: TimeInterval = 12
  private static let enrichmentTTL: TimeInterval = 3600
  private static let upstreamTTL: TimeInterval = 60
  private static let tomtomDailyBudget = 6000

  /// Same-host hops tolerated on one read-through; anything else is refused.
  private static let upstreamMaxRedirects = 3
  /// WFIGS serves its perimeter pages as GeoJSON; a peak-season page is a few MB.
  private static let upstreamMaxBytes = 16 * 1024 * 1024

  private static let openskyStates =
    "https://opensky-network.org/api/states/all?extended=1"

  /// The host list the in-page adapters may read through. Short and fixed on
  /// purpose: this route is a relay for known cross-origin reads, not a proxy.
  private static let upstreamHosts: Set<String> = [
    "api.windy.com",
    "tiles.windy.com",
    "api.tomtom.com",
    "api.adsb.lol",
    "services3.arcgis.com",
    // GDACS current events (no CORS header any more; the disasters layer
    // fetches its pages through /api/upstream).
    "www.gdacs.org",
    // NHC cyclone status and its published forecast GIS layers.
    "www.nhc.noaa.gov",
    "mapservices.weather.noaa.gov",
    // NASA FIRMS active fire open global CSV feeds.
    "firms.modaps.eosdis.nasa.gov",
    // NOAA nowCOAST observations (WMS radar, satellite clouds, lightning).
    "nowcoast.noaa.gov",
    // NOAA GFS bucket on AWS S3.
    "noaa-gfs-bdp-pds.s3.amazonaws.com",
    // Radio Browser mirrors; the page rotates through them.
    "de1.api.radio-browser.info",
    "de2.api.radio-browser.info",
    "nl1.api.radio-browser.info",
    // GTFS-Realtime VehiclePositions feeds, one host per registered feed
    // (src/data/transitFeeds.js). The page decodes the protobuf itself.
    "cdn.mbta.com",
    "data.texas.gov",
    "svc.metrotransit.org",
    "realtime.hsl.fi",
    "gtfs.ovapi.nl",
    "gtfsrt.api.translink.com.au",
    "bustime.ttc.ca",
    "www.miapp.ca",
    "opendata.hamilton.ca",
    "drtonline.durhamregiontransit.com",
    "glphprdtmgtfs.glphtrpcloud.com",
    "api.cityofkingston.ca",
    "www.myridebarrie.ca",
    "rtu.york.ca",
    "opendata.burlington.ca",
    // French transit networks (src/data/transitFeeds.js).
    "proxy.transport.data.gouv.fr",
    "ara-api.enroute.mobi",
    "gtfsproxy.e-tam.fr",
    "api.mrn.cityway.fr",
    "data.filbleu.fr",
    "opendata.transports-lia.fr",
    "app.pysae.com",
    // GBFS station documents: the bikeshare proxy's allowlist
    // (src/data/gbfsSource.js) and the cities in its registry.
    "gbfs.lyft.com",
    "gbfs.bluebikes.com",
    "gbfs.bcycle.com",
    "gbfs.biketownpdx.com",
    "reddybikeshare.socialbicycles.com",
    "gbfs.nextbike.net",
    "gbfs.urbansharing.com",
    "api.cyclocity.fr",
    "austin.publicbikesystem.net",
    "hon.publicbikesystem.net",
    "chat.publicbikesystem.net",
    // Entur fronts both a transit feed and Norwegian GBFS under one host.
    "api.entur.io",
    // Re:Earth point heights: the terrain the vehicles and floors stand on.
    "terrain.reearth.land",
    // Radiation networks (BfS, Health Canada, Safecast, Radmon, NOAA SWPC).
    "www.imis.bfs.de",
    "maps-cartes.services.geo.ca",
    "api.safecast.org",
    "radmon.org",
    "services.swpc.noaa.gov",
  ]

  private let cache = BodyCache()

  /// Explicit and internal: the stored cache property is private, which would
  /// otherwise make the implicit memberwise initializer private to this file.
  init() {}

  // MARK: - Routing

  /// @return the response, or `nil` when the path is not an `/api` route.
  func handle(_ request: HTTPRequest) async -> HTTPResponse? {
    let rawPath = request.path
    guard rawPath == "/api" || rawPath.hasPrefix("/api/") else { return nil }

    if request.method == "OPTIONS" {
      return HTTPResponse(status: 204, headers: [:], body: Data())
    }
    guard request.method == "GET" || request.method == "HEAD" else {
      return json(405, [
        "error": "method_not_allowed",
        "detail":
          "The in-app API serves GET and HEAD only. A POST route needs a hosted copy of this project (GEV_API_BASE).",
      ])
    }

    let path = Self.trimTrailing(rawPath)
    let params = Self.parseQuery(request.query)

    do {
      if path == "/api/health" {
        return health()
      }
      if rawPath.hasPrefix("/api/celestrak/") {
        return try await celestrak(
          String(rawPath.dropFirst("/api/celestrak/".count))
        )
      }
      if path == "/api/flights" || path == "/api/opensky" {
        return try await flights(params)
      }
      if path == "/api/flights/track" || path == "/api/opensky-track" {
        return try await track(params["icao24"])
      }
      if path == "/api/military" || path == "/api/adsblol/mil" {
        return await military()
      }
      if rawPath.hasPrefix("/api/adsbdb/") {
        return try await enrichment(
          String(rawPath.dropFirst("/api/adsbdb/".count))
        )
      }
      if path == "/api/upstream" {
        return await upstream(params)
      }
      if path == "/api/vessels" || path == "/api/vessels/track" {
        return noKey("The AIS vessels feed")
      }
      if path == "/api/fishing-effort" {
        return noKey("Global Fishing Watch")
      }
      if path == "/api/launches" {
        return try await launches()
      }
      if path == "/api/tomtom/status" {
        return tomtomStatus()
      }
      if rawPath.hasPrefix("/api/tomtom/flow/") {
        return noKey("TomTom traffic tiles")
      }
    } catch {
      NSLog("[GodsEyeView] live API \(rawPath) failed: \(error.localizedDescription)")
      return json(
        502,
        [
          "error": "upstream_unavailable",
          "detail": String(describing: error),
        ],
        headers: ["Cache-Control": "no-store"]
      )
    }

    return json(
      404,
      [
        "error": "not_proxied",
        "path": rawPath,
        "detail":
          "This route is not part of the in-app keyless API. It needs a hosted copy of this project (GEV_API_BASE) or a provider key.",
      ],
      headers: ["Cache-Control": "no-store"]
    )
  }

  /// @return an in-app answer for a request the hosted server failed, or `nil`
  /// to keep the server's answer.
  ///
  /// A hosted copy is the primary source, but it cannot always reach an
  /// upstream: CelesTrak refuses a datacentre rebroadcast, adsb.lol answers a
  /// shared address with 429, and the server's `/api/upstream` list is narrower
  /// than the shell's own. Those are facts about the server's address, not
  /// about this request, so the in-app copy is the better answer. Every other
  /// status — a missing key, a bad request, a foreign Host — is a decision and
  /// is passed through.
  func rescue(
    _ request: HTTPRequest,
    forwarded: HTTPResponse
  ) async -> HTTPResponse? {
    let status = forwarded.status
    let serverRateLimited = status == 429
    let upstreamRefused = status >= 400 && request.path == "/api/upstream"
    guard status >= 500 || serverRateLimited || upstreamRefused else {
      return nil
    }
    guard request.method == "GET" || request.method == "HEAD" else {
      return nil
    }
    guard let local = await handle(request) else { return nil }
    // A 404 here would replace a real server failure with "not ported".
    guard local.status < 500, local.status != 404 else { return nil }
    return local
  }

  // MARK: - Routes

  private func health() -> HTTPResponse {
    json(200, [
      "ok": true,
      "service": "gods-eye-view ios live api",
      "routes": [
        "/api/health",
        "/api/celestrak/{group}",
        "/api/flights",
        "/api/opensky",
        "/api/flights/track?icao24={hex}",
        "/api/military",
        "/api/adsbdb/{kind}/{id}",
        "/api/launches",
        "/api/upstream?url={https}",
        "/api/tomtom/status",
      ],
    ])
  }

  private func celestrak(_ group: String) async throws -> HTTPResponse {
    guard
      group.range(of: "^[A-Za-z0-9-]{1,40}$", options: .regularExpression)
        != nil
    else {
      return json(400, ["error": "invalid_group"])
    }

    let key = "celestrak:" + group
    var entry = cache.read(key)
    var state = "HIT"
    if entry == nil || entry!.age >= Self.celestrakTTL {
      do {
        let encoded =
          group.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
          ?? group
        let body = try await get(
          "https://celestrak.org/NORAD/elements/gp.php?GROUP=\(encoded)&FORMAT=tle",
          accept: "text/plain"
        )
        if Self.hasTleLines(body) {
          entry = cache.write(key, body)
          state = "MISS"
        }
      } catch {
        NSLog("[GodsEyeView] CelesTrak refresh failed for \(group)")
      }
      // An upstream error page parses to zero TLEs: keep the last good copy.
      if state != "MISS" && entry != nil { state = "STALE" }
    }

    guard let cached = entry else {
      return json(
        502,
        ["error": "celestrak_unavailable"],
        headers: ["Cache-Control": "no-store"]
      )
    }
    return bytes(
      200,
      cached.body,
      mime: "text/plain; charset=utf-8",
      headers: ["x-tle-cache": state]
    )
  }

  private func flights(_ params: [String: String]) async throws -> HTTPResponse {
    let key = "opensky:states"
    var entry = cache.read(key)
    var state = "HIT"
    let fresh = entry != nil && entry!.age < Self.flightsTTL
    if !fresh {
      do {
        let body = try await get(Self.openskyStates)
        if Self.isJSON(body) {
          entry = cache.write(key, body)
          state = "MISS"
        }
      } catch {
        NSLog("[GodsEyeView] OpenSky refresh failed: \(error.localizedDescription)")
      }
      if state != "MISS" && entry != nil { state = "STALE" }
    }

    if let cached = entry {
      return bytes(
        200,
        cached.body,
        mime: "application/json; charset=utf-8",
        headers: [
          "x-feed-source": "OpenSky Network",
          "x-flight-source": "OpenSky Network",
          "x-flight-coverage": "worldwide upstream snapshot",
          "x-opensky-cache": state,
        ]
      )
    }

    if let lat = params["lat"], let lon = params["lon"],
      let fallback = await adsbLolSnapshot(lat: lat, lon: lon)
    {
      return bytes(
        200,
        fallback,
        mime: "application/json; charset=utf-8",
        headers: [
          "x-feed-source": "adsb.lol",
          "x-flight-source": "adsb.lol",
          "x-flight-coverage": "250 nm point snapshot",
          "x-opensky-cache": "FALLBACK",
        ]
      )
    }

    return json(
      502,
      ["error": "flights_unavailable"],
      headers: ["Cache-Control": "no-store"]
    )
  }

  /// Map a readsb snapshot to OpenSky state vectors, the order the client
  /// reads: icao24, callsign, origin country, position time, last contact,
  /// longitude, latitude, baro altitude, on ground, velocity, true track,
  /// vertical rate, sensors, geo altitude, squawk, spi, source, category.
  private func adsbLolSnapshot(lat: String, lon: String) async -> Data? {
    guard let latitude = Double(lat), let longitude = Double(lon),
      abs(latitude) <= 90, abs(longitude) <= 180
    else { return nil }

    let target = String(
      format: "https://api.adsb.lol/v2/lat/%.2f/lon/%.2f/dist/250",
      locale: Locale(identifier: "en_US_POSIX"),
      latitude,
      longitude
    )
    do {
      let body = try await get(target, accept: "application/json")
      guard let object = try? JSONSerialization.jsonObject(with: body),
        let payload = object as? [String: Any],
        let aircraft = payload["ac"] as? [[String: Any]]
      else { return nil }

      let nowS = Int(Date().timeIntervalSince1970)
      var states: [[Any]] = []
      states.reserveCapacity(aircraft.count)
      for row in aircraft {
        let hex = Self.string(row, "hex").lowercased()
        guard !hex.isEmpty, Self.number(row, "lat") != nil,
          Self.number(row, "lon") != nil
        else { continue }

        let ground = (row["alt_baro"] as? String)?.lowercased() == "ground"
        let baroFt = Self.number(row, "alt_baro")
        let geoFt = Self.number(row, "alt_geom")
        let speedKt = Self.number(row, "gs")
        let trackDeg = Self.number(row, "track")
        let rateFtMin = Self.number(row, "baro_rate")
        let category = Self.string(row, "category")

        var state: [Any] = []
        state.append(hex)
        state.append(Self.string(row, "flight").trimmingCharacters(in: .whitespaces))
        state.append("")
        state.append(Self.seconds(row, "seen_pos", nowS))
        state.append(Self.seconds(row, "seen", nowS))
        state.append(Self.orNull(Self.number(row, "lon")))
        state.append(Self.orNull(Self.number(row, "lat")))
        state.append(
          ground ? (0.0 as Any) : Self.orNull(baroFt.map { $0 * 0.3048 })
        )
        state.append(ground)
        state.append(Self.orNull(speedKt.map { $0 * 0.514444 }))
        state.append(Self.orNull(trackDeg))
        state.append(Self.orNull(rateFtMin.map { $0 * 0.00508 }))
        state.append(NSNull())
        state.append(Self.orNull(geoFt.map { $0 * 0.3048 }))
        state.append(Self.string(row, "squawk"))
        state.append(false)
        state.append(1)
        if category.count == 2,
          category.hasPrefix("A") || category.hasPrefix("B"),
          let number = Int(String(category.dropFirst()))
        {
          state.append(number)
        } else {
          state.append(NSNull())
        }
        states.append(state)
      }

      let merged: [String: Any] = ["time": nowS, "states": states]
      return try JSONSerialization.data(withJSONObject: merged)
    } catch {
      NSLog("[GodsEyeView] adsb.lol fallback failed: \(error.localizedDescription)")
      return nil
    }
  }

  private func track(_ rawIcao: String?) async throws -> HTTPResponse {
    let hex = (rawIcao ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
    guard hex.range(of: "^[0-9a-f]{6}$", options: .regularExpression) != nil else {
      return json(400, ["error": "invalid_icao24"])
    }

    let key = "track:" + hex
    var entry = cache.read(key)
    if entry == nil || entry!.age >= Self.trackTTL {
      do {
        let body = try await get(
          "https://opensky-network.org/api/tracks/all?icao24=\(hex)&time=0"
        )
        if Self.isJSON(body) { entry = cache.write(key, body) }
      } catch {
        if entry == nil {
          return json(
            502,
            ["error": "track_unavailable"],
            headers: ["Cache-Control": "no-store"]
          )
        }
      }
    }
    guard let cached = entry else {
      return json(
        502,
        ["error": "track_unavailable"],
        headers: ["Cache-Control": "no-store"]
      )
    }
    return bytes(
      200,
      cached.body,
      mime: "application/json; charset=utf-8",
      headers: [:]
    )
  }

  /// The military feeds this shell reads, merged the way the project's server
  /// merges them: each network is a different set of receivers, so the same
  /// minute of sky comes back overlapping and different.
  private static let militaryFeeds: [(id: String, url: String)] = [
    ("adsb.lol", "https://api.adsb.lol/v2/mil"),
    ("adsb.fi", "https://opendata.adsb.fi/api/v2/mil"),
  ]

  private func military() async -> HTTPResponse {
    var byIcao: [String: [String: Any]] = [:]
    var unkeyed: [[String: Any]] = []
    var answered: [String] = []
    var reported: [String] = []

    for feed in Self.militaryFeeds {
      let key = "mil:" + feed.id
      var entry = cache.read(key)
      if entry == nil || entry!.age >= Self.militaryTTL {
        do {
          let body = try await get(feed.url)
          if Self.isJSON(body) { entry = cache.write(key, body) }
        } catch {
          // One feed down never costs the others their data.
          if entry == nil { continue }
        }
      }
      guard let cached = entry,
        let aircraft = Self.militaryAircraft(cached.body)
      else { continue }

      answered.append(feed.id)
      var count = 0
      for contact in aircraft {
        count += 1
        var row = contact
        let icao = Self.string(row, "hex")
          .trimmingCharacters(in: .whitespacesAndNewlines)
          .lowercased()
        if icao.isEmpty {
          unkeyed.append(row)
          continue
        }
        // The ICAO24 is the row's identity, so the merged answer spells it one
        // way however the feed that won happened to write it.
        row["hex"] = icao
        if let incumbent = byIcao[icao] {
          if Self.preferredMilitaryRow(row, incumbent) { byIcao[icao] = row }
        } else {
          byIcao[icao] = row
        }
      }
      reported.append("\(feed.id)=\(count)")
    }

    if answered.isEmpty {
      return json(
        502,
        ["error": "military_unavailable"],
        headers: ["Cache-Control": "no-store"]
      )
    }

    var merged: [String: Any] = [:]
    let rows = Array(byIcao.values) + unkeyed
    merged["ac"] = rows
    merged["total"] = rows.count
    let body =
      (try? JSONSerialization.data(withJSONObject: merged)) ?? Data("{}".utf8)
    return bytes(
      200,
      body,
      mime: "application/json; charset=utf-8",
      headers: [
        "x-feed-source": answered.joined(separator: "+"),
        "x-military-sources": reported.joined(separator: ","),
      ]
    )
  }

  private static func militaryAircraft(_ body: Data) -> [[String: Any]]? {
    guard let object = try? JSONSerialization.jsonObject(with: body),
      let payload = object as? [String: Any]
    else { return nil }
    return payload["ac"] as? [[String: Any]]
  }

  /// A row with a position always wins: the aircraft layers drop a
  /// positionless contact. Between two positioned rows the freshest
  /// observation wins, and a tie keeps the incumbent so the answer is stable
  /// between refreshes.
  private static func preferredMilitaryRow(
    _ candidate: [String: Any],
    _ incumbent: [String: Any]
  ) -> Bool {
    let candidatePositioned = militaryPositioned(candidate)
    if candidatePositioned != militaryPositioned(incumbent) {
      return candidatePositioned
    }
    guard let candidateSeen = number(candidate, "seen_pos") else { return false }
    guard let incumbentSeen = number(incumbent, "seen_pos") else { return true }
    return candidateSeen < incumbentSeen
  }

  private static func militaryPositioned(_ row: [String: Any]) -> Bool {
    guard let latitude = number(row, "lat"),
      let longitude = number(row, "lon")
    else { return false }
    return abs(latitude) <= 90 && abs(longitude) <= 180
  }

  private func enrichment(_ tail: String) async throws -> HTTPResponse {
    guard
      tail.range(
        of: "^(callsign|aircraft)/[A-Za-z0-9]{1,10}$",
        options: .regularExpression
      ) != nil
    else {
      return json(400, ["error": "invalid_lookup"])
    }

    let key = "adsbdb:" + tail
    var entry = cache.read(key)
    if entry == nil || entry!.age >= Self.enrichmentTTL {
      do {
        let body = try await get("https://api.adsbdb.com/v0/" + tail)
        if Self.isJSON(body) { entry = cache.write(key, body) }
      } catch {
        if entry == nil {
          return json(
            502,
            ["error": "enrichment_unavailable"],
            headers: ["Cache-Control": "no-store"]
          )
        }
      }
    }
    guard let cached = entry else {
      return json(
        502,
        ["error": "enrichment_unavailable"],
        headers: ["Cache-Control": "no-store"]
      )
    }
    return bytes(
      200,
      cached.body,
      mime: "application/json; charset=utf-8",
      headers: [:]
    )
  }

  private func launches() async throws -> HTTPResponse {
    let key = "ll2:recent"
    let entry = cache.read(key)
    if entry == nil || entry!.age >= Self.launchesTTL {
      let now = Date()
      var components = URLComponents(
        string: "https://ll.thespacedevs.com/2.3.0/launches/"
      )
      components?.queryItems = [
        URLQueryItem(
          name: "net__gte",
          value: Self.iso(now.addingTimeInterval(-30 * 86_400.0))
        ),
        URLQueryItem(name: "net__lte", value: Self.iso(now)),
        URLQueryItem(name: "limit", value: "100"),
        URLQueryItem(name: "mode", value: "detailed"),
      ]
      guard let target = components?.url?.absoluteString else {
        throw LiveApiError.invalidURL
      }
      do {
        let body = try await get(target)
        if Self.isJSON(body) {
          let fresh = cache.write(key, body)
          return bytes(
            200,
            fresh.body,
            mime: "application/json; charset=utf-8",
            headers: [:]
          )
        }
      } catch {
        if let cached = entry {
          return bytes(
            200,
            cached.body,
            mime: "application/json; charset=utf-8",
            headers: [:]
          )
        }
        throw error
      }
    }
    guard let cached = entry else {
      return json(
        502,
        ["error": "launches_unavailable"],
        headers: ["Cache-Control": "no-store"]
      )
    }
    return bytes(
      200,
      cached.body,
      mime: "application/json; charset=utf-8",
      headers: [:]
    )
  }

  private func tomtomStatus() -> HTTPResponse {
    json(200, [
      "hasKey": false,
      "dailyCount": 0,
      "budget": Self.tomtomDailyBudget,
      "date": Self.day(Date()),
    ])
  }

  // MARK: - Bounded read-through

  private func upstream(_ params: [String: String]) async -> HTTPResponse {
    guard let raw = params["url"], !raw.isEmpty else {
      return json(400, ["error": "missing_url"])
    }
    guard let target = URL(string: raw),
      target.scheme?.lowercased() == "https",
      let host = target.host?.lowercased(),
      Self.upstreamHostAllowed(host)
    else {
      return json(403, ["error": "host_not_allowed"])
    }

    let binary = params["binary"] == "1"
    let key = "upstream:" + raw
    if let entry = cache.read(key), entry.age < Self.upstreamTTL {
      return upstreamBody(entry.body, binary: binary, cache: "HIT")
    }

    do {
      let body = try await Self.readUpstream(target)
      guard !body.isEmpty else { throw LiveApiError.emptyBody }
      cache.write(key, body)
      return upstreamBody(body, binary: binary, cache: "MISS")
    } catch {
      if let entry = cache.read(key) {
        return upstreamBody(entry.body, binary: binary, cache: "STALE")
      }
      return json(
        502,
        [
          "error": "upstream_unavailable",
          "detail": String(describing: error),
        ],
        headers: ["Cache-Control": "no-store"]
      )
    }
  }

  /// Hand one read-through body back as the caller asked for it.
  ///
  /// A protobuf feed cannot travel as text: telling the page the type is JSON
  /// makes it decode the bytes as UTF-8 before the page can read them.
  /// `binary=1` therefore answers octet-stream with no charset.
  private func upstreamBody(
    _ body: Data,
    binary: Bool,
    cache: String
  ) -> HTTPResponse {
    bytes(
      200,
      body,
      mime: binary
        ? "application/octet-stream" : "application/json; charset=utf-8",
      headers: ["x-upstream-cache": cache]
    )
  }

  /// Read one allowlisted host, following a few redirects that stay on it.
  private static func readUpstream(_ target: URL) async throws -> Data {
    guard target.scheme?.lowercased() == "https",
      let host = target.host?.lowercased(),
      upstreamHostAllowed(host)
    else { throw LiveApiError.hostNotAllowed }

    var current = target
    for _ in 0...upstreamMaxRedirects {
      var request = URLRequest(url: current)
      request.httpMethod = "GET"
      request.timeoutInterval = 20
      request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
      request.setValue("*/*", forHTTPHeaderField: "Accept")
      request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")

      let (data, response) = try await session.data(for: request)
      let http = response as? HTTPURLResponse
      let status = http?.statusCode ?? 502

      if (300..<400).contains(status) {
        guard let location = http?.value(forHTTPHeaderField: "Location"),
          let next = URL(string: location, relativeTo: current)?.absoluteURL,
          next.scheme?.lowercased() == "https",
          let nextHost = next.host?.lowercased(),
          nextHost == host,
          upstreamHostAllowed(nextHost)
        else { throw LiveApiError.refusedRedirect }
        current = next
        continue
      }

      guard (200..<300).contains(status) else {
        throw LiveApiError.httpStatus(status)
      }
      guard data.count <= upstreamMaxBytes else {
        throw LiveApiError.bodyTooLarge
      }
      return data
    }
    throw LiveApiError.tooManyRedirects
  }

  private static func upstreamHostAllowed(_ host: String) -> Bool {
    let lower = host.lowercased()
    if lower.hasSuffix(".publicbikesystem.net") { return true }
    return upstreamHosts.contains(lower)
  }

  // MARK: - Transport and small helpers

  /// A session that never follows a redirect on its own: `/api/upstream`
  /// re-checks each hop against the host that was validated.
  private static let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 20
    configuration.timeoutIntervalForResource = 30
    configuration.httpAdditionalHeaders = ["Accept-Encoding": "identity"]
    return URLSession(
      configuration: configuration,
      delegate: NoRedirects(),
      delegateQueue: nil
    )
  }()

  private func get(
    _ target: String,
    accept: String = "application/json, text/plain, */*"
  ) async throws -> Data {
    guard let url = URL(string: target),
      url.scheme?.lowercased() == "https"
    else { throw LiveApiError.invalidURL }

    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.timeoutInterval = 20
    request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
    request.setValue(accept, forHTTPHeaderField: "Accept")
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")

    let (data, response) = try await Self.session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 502
    guard (200..<300).contains(status) else {
      throw LiveApiError.httpStatus(status)
    }
    return data
  }

  private func json(
    _ status: Int,
    _ object: [String: Any],
    headers: [String: String] = [:]
  ) -> HTTPResponse {
    let data =
      (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    var all = headers
    all["Content-Type"] = "application/json; charset=utf-8"
    all["Cache-Control"] = all["Cache-Control"] ?? "no-store"
    return HTTPResponse(status: status, headers: all, body: data)
  }

  private func bytes(
    _ status: Int,
    _ body: Data,
    mime: String,
    headers: [String: String]
  ) -> HTTPResponse {
    var all = headers
    all["Content-Type"] = mime
    all["Cache-Control"] = all["Cache-Control"] ?? "no-store"
    return HTTPResponse(status: status, headers: all, body: body)
  }

  private func noKey(_ source: String) -> HTTPResponse {
    json(
      503,
      [
        "error": "no_key",
        "detail":
          "\(source) needs a provider key on a hosted copy of this project. Set GEV_API_BASE when packaging, or add the key there; the in-app shell never ships a server-side key.",
      ],
      headers: ["Cache-Control": "no-store"]
    )
  }

  private static func hasTleLines(_ body: Data) -> Bool {
    guard let text = String(data: body, encoding: .utf8) else { return false }
    return text.contains("\n1 ") || text.hasPrefix("1 ")
  }

  private static func isJSON(_ body: Data) -> Bool {
    guard body.count >= 2 else { return false }
    return (try? JSONSerialization.jsonObject(with: body)) != nil
  }

  private static func trimTrailing(_ path: String) -> String {
    var end = path.count
    while end > 1 {
      let index = path.index(path.startIndex, offsetBy: end - 1)
      if path[index] != "/" { break }
      end -= 1
    }
    return String(path.prefix(end))
  }

  private static func parseQuery(_ query: String) -> [String: String] {
    var out: [String: String] = [:]
    guard !query.isEmpty else { return out }
    for pair in query.split(separator: "&") {
      guard let split = pair.firstIndex(of: "=") else { continue }
      let rawName = String(pair[..<split])
      let rawValue = String(pair[pair.index(after: split)...])
      let name = decodeQueryComponent(rawName)
      let value = decodeQueryComponent(rawValue)
      if !name.isEmpty { out[name] = value }
    }
    return out
  }

  private static func decodeQueryComponent(_ raw: String) -> String {
    (raw.replacingOccurrences(of: "+", with: " ")).removingPercentEncoding
      ?? raw
  }

  private static func string(_ row: [String: Any], _ key: String) -> String {
    row[key] as? String ?? ""
  }

  private static func number(_ row: [String: Any], _ key: String) -> Double? {
    if let value = row[key] as? NSNumber { return value.doubleValue }
    if let text = row[key] as? String, let value = Double(text) {
      return value
    }
    return nil
  }

  private static func seconds(
    _ row: [String: Any],
    _ key: String,
    _ nowS: Int
  ) -> Any {
    guard let value = number(row, key), value.isFinite else { return NSNull() }
    return nowS - Int(value)
  }

  private static func orNull(_ value: Double?) -> Any {
    guard let value, value.isFinite else { return NSNull() }
    return value
  }

  private static func iso(_ date: Date) -> String {
    isoFormatter.string(from: date)
  }

  private static func day(_ date: Date) -> String {
    dayFormatter.string(from: date)
  }

  private static let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
  }()

  private static let dayFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter
  }()
}

/// One cached upstream body with the moment it arrived.
private struct CachedBody {
  let body: Data
  let at: Date

  var age: TimeInterval { Date().timeIntervalSince(at) }
}

/// A tiny in-memory cache, the counterpart of the APK's `LiveApi.cache`.
private final class BodyCache {
  private static let limit = 48

  private let lock = NSLock()
  private var entries: [String: CachedBody] = [:]

  func read(_ key: String) -> CachedBody? {
    lock.lock()
    defer { lock.unlock() }
    return entries[key]
  }

  @discardableResult
  func write(_ key: String, _ body: Data) -> CachedBody {
    let entry = CachedBody(body: body, at: Date())
    lock.lock()
    defer { lock.unlock() }
    if entries[key] == nil, entries.count >= Self.limit,
      let oldest = entries.keys.first
    {
      entries.removeValue(forKey: oldest)
    }
    entries[key] = entry
    return entry
  }
}

/// Refuses every redirect, so `readUpstream` can check each hop itself.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

private enum LiveApiError: LocalizedError {
  case invalidURL
  case hostNotAllowed
  case refusedRedirect
  case tooManyRedirects
  case bodyTooLarge
  case emptyBody
  case httpStatus(Int)

  var errorDescription: String? {
    switch self {
    case .invalidURL:
      return "invalid URL"
    case .hostNotAllowed:
      return "host not allowed"
    case .refusedRedirect:
      return "redirect refused"
    case .tooManyRedirects:
      return "too many redirects"
    case .bodyTooLarge:
      return "body too large"
    case .emptyBody:
      return "empty upstream body"
    case let .httpStatus(status):
      return "HTTP \(status)"
    }
  }
}
