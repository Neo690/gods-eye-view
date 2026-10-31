package com.godseye.view;

import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Answers the console's {@code /api/*} calls from inside the app.
 *
 * <p>The live layers never talk to CelesTrak or OpenSky directly: they ask
 * their own origin for {@code /api/...} and expect the project's Vite
 * middleware to do the fetch. A standalone APK has no Node process, so those
 * calls landed on the asset store as 404 and every network layer reported
 * {@code UNAVAILABLE}. {@link ApiForwarder} covers the case where a hosted copy
 * of the server exists; this class is the fallback for a build that has none,
 * and it covers the keyless feeds the space, aircraft and traffic layers read.
 *
 * <p>Requests run in Java, so no CORS applies and no {@code Origin} is sent.
 * Each route mirrors the contract of its counterpart in {@code server/}: same
 * upstream URL, same cache window, same headers the client already parses.
 *
 * <p>Endpoints that need a credential (TomTom traffic, CCTV, Google, the AI
 * summary) answer with the same shape a keyless server would, so the layer
 * reports "needs a key" instead of a bare HTTP error.
 */
final class LiveApi {

  private static final String TAG = "GodsEyeView";
  private static final String API_PREFIX = "/api/";
  private static final String USER_AGENT =
    "gods-eye-view-android-shell/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)";

  private static final long CELESTRAK_TTL_MS = 6 * 3600_000L;
  private static final long FLIGHTS_TTL_MS = 10_000L;
  private static final long TRACK_TTL_MS = 60_000L;
  private static final long LAUNCHES_TTL_MS = 15 * 60_000L;
  private static final int TOMTOM_DAILY_BUDGET = 6000;
  private static final String TOMTOM_KEY = "zDNAGgmUTtoeAEksaJypzb00x8V9s607";
  private static final long TOMTOM_TILE_TTL_MS = 120_000L;

  /**
   * The in-page adapters run the project's own normalisers over a body they
   * cannot fetch themselves: a cross-origin GET from the WebView is refused by
   * CORS. They ask this route instead, which is why the host list is short and
   * fixed rather than a general proxy.
   */
  private static final long UPSTREAM_TTL_MS = 60_000L;
  /** Same-host hops tolerated on one read-through; anything else is refused. */
  private static final int UPSTREAM_MAX_REDIRECTS = 3;
  // WFIGS serves its perimeter pages as GeoJSON; a peak-season page is a few MB.
  private static final int UPSTREAM_MAX_BYTES = 16 * 1024 * 1024;
  private static final String[] UPSTREAM_HOSTS = {
    "api.windy.com",
    "tiles.windy.com",
    "api.tomtom.com",
    "api.adsb.lol",
    "services3.arcgis.com",
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
  };

  private static final int CONNECT_TIMEOUT_MS = 8000;
  private static final int READ_TIMEOUT_MS = 20000;
  private static final int MAX_CACHE_ENTRIES = 48;

  private static final String OPENSKY_STATES =
    "https://opensky-network.org/api/states/all?extended=1";

  private static final ConcurrentHashMap<String, Cached> cache =
    new ConcurrentHashMap<>();

  private LiveApi() {}

  static boolean handles(String path) {
    return path != null && path.startsWith(API_PREFIX);
  }

  /** @return the response, or {@code null} when the path is not ours. */
  static WebResourceResponse serve(WebResourceRequest request) {
    String method = request.getMethod() == null
      ? "GET"
      : request.getMethod().toUpperCase(Locale.ROOT);
    String path = request.getUrl().getPath() == null ? "" : request.getUrl().getPath();
    if (!handles(path)) return null;

    if ("OPTIONS".equals(method)) {
      return bytes(204, "No Content", "text/plain", "utf-8", new byte[0], headers());
    }
    if (!"GET".equals(method) && !"HEAD".equals(method)) {
      return json(
        405,
        "Method Not Allowed",
        "{\"error\":\"method_not_allowed\"}",
        headers()
      );
    }

    String query = request.getUrl().getEncodedQuery();
    Map<String, String> params = parseQuery(query);

    try {
      if ("/api/health".equals(trimTrailing(path))) {
        return json(200, "OK", healthJson(), headers());
      }
      if (path.startsWith("/api/celestrak/")) {
        return celestrak(path.substring("/api/celestrak/".length()));
      }
      // Both spellings exist in the tree: the console asks /api/opensky, the
      // standalone source asks /api/flights. Same proxy behind both.
      String route = trimTrailing(path);
      if ("/api/flights".equals(route) || "/api/opensky".equals(route)) {
        return flights(params);
      }
      if (
        "/api/flights/track".equals(route) || "/api/opensky-track".equals(route)
      ) {
        return track(params.get("icao24"));
      }
      if ("/api/military".equals(route) || "/api/adsblol/mil".equals(route)) {
        return military();
      }
      if (path.startsWith("/api/adsbdb/")) {
        return enrichment(path.substring("/api/adsbdb/".length()));
      }
      if ("/api/upstream".equals(route)) {
        return upstream(params.get("url"), "1".equals(params.get("binary")));
      }
      if ("/api/vessels".equals(route) || "/api/vessels/track".equals(route)) {
        // AISStream is a long-lived socket, which a shell cannot hold.
        return json(
          503,
          "Service Unavailable",
          "{\"error\":\"no_key\"}",
          headers()
        );
      }
      if ("/api/fishing-effort".equals(route)) {
        // The Global Fishing Watch token is server-side by design (the report
        // endpoint runs one report per token at a time), so a shell cannot
        // answer this from the phone. It declares the route anyway: the default
        // below is a 404, and the rescue path accepts any answer under 500, so
        // an unset server key arrived as "Fishing effort HTTP 404" — a wrong
        // reason that hid the real one. A 5xx here leaves the server's own
        // answer (200 with the token, 503 no_key without it) in place.
        return json(
          503,
          "Service Unavailable",
          "{\"error\":\"no_key\"}",
          headers()
        );
      }
      if ("/api/launches".equals(route)) {
        return launches();
      }
      if ("/api/tomtom/status".equals(trimTrailing(path))) {
        return tomtomStatus();
      }
      if (path.startsWith("/api/tomtom/flow/")) {
        return tomtomFlow(path);
      }
      if (path.startsWith("/api/weather/tile")) {
        return weatherTile(params);
      }
      if (path.startsWith("/api/weather/image")) {
        return weatherImage(params);
      }
    } catch (IOException failure) {
      Log.w(TAG, "Live API " + path + " failed: " + failure.getMessage());
      return json(
        502,
        "Bad Gateway",
        "{\"error\":\"upstream_unavailable\",\"detail\":" + quote(
          failure.getClass().getSimpleName()
        ) + "}",
        headers("Cache-Control", "no-store")
      );
    }

    return json(
      404,
      "Not Found",
      "{\"error\":\"not_proxied\",\"path\":" + quote(path) + "}",
      headers("Cache-Control", "no-store")
    );
  }

  /* ── CelesTrak ──────────────────────────────────────────────────────── */

  private static WebResourceResponse celestrak(String group) throws IOException {
    if (!group.matches("[A-Za-z0-9-]{1,40}")) {
      return json(400, "Bad Request", "{\"error\":\"invalid_group\"}", headers());
    }
    Cached entry = cache.get("celestrak:" + group);
    String state = "HIT";
    if (entry == null || entry.ageMs() >= CELESTRAK_TTL_MS) {
      byte[] body = null;
      try {
        body = get(
          "https://celestrak.org/NORAD/elements/gp.php?GROUP=" +
            URLEncoder.encode(group, "UTF-8") +
            "&FORMAT=tle"
        );
      } catch (IOException failure) {
        Log.w(TAG, "CelesTrak refresh failed for " + group);
      }
      // An upstream error page parses to zero TLEs: keep the last good copy.
      if (body != null && hasTleLines(body)) {
        entry = new Cached(body);
        remember("celestrak:" + group, entry);
        state = "MISS";
      } else if (entry == null) {
        return json(
          502,
          "Bad Gateway",
          "{\"error\":\"celestrak_unavailable\"}",
          headers("Cache-Control", "no-store")
        );
      } else {
        state = "STALE";
      }
    }
    return bytes(
      200,
      "OK",
      "text/plain",
      "utf-8",
      entry.body,
      headers("x-tle-cache", state)
    );
  }

  private static boolean hasTleLines(byte[] body) {
    String text = new String(body, StandardCharsets.UTF_8);
    return text.contains("\n1 ") || text.startsWith("1 ");
  }

  /* ── OpenSky, with the bounded regional fallback ─────────────────────── */

  private static WebResourceResponse flights(Map<String, String> params)
    throws IOException {
    Cached entry = cache.get("opensky:states");
    String state = "HIT";
    boolean fresh = entry != null && entry.ageMs() < FLIGHTS_TTL_MS;
    if (!fresh) {
      byte[] body = null;
      try {
        body = get(OPENSKY_STATES);
      } catch (IOException failure) {
        Log.w(TAG, "OpenSky refresh failed: " + failure.getMessage());
      }
      if (body != null && isJson(body)) {
        entry = new Cached(body);
        remember("opensky:states", entry);
        state = "MISS";
      } else if (entry != null) {
        state = "STALE";
      }
    }

    if (entry != null) {
      return bytes(
        200,
        "OK",
        "application/json",
        "utf-8",
        entry.body,
        headers(
          "x-feed-source",
          "OpenSky Network",
          "x-flight-source",
          "OpenSky Network",
          "x-flight-coverage",
          "worldwide upstream snapshot",
          "x-opensky-cache",
          state
        )
      );
    }

    String lat = params.get("lat");
    String lon = params.get("lon");
    if (lat != null && lon != null) {
      byte[] fallback = adsbLolSnapshot(lat, lon);
      if (fallback != null) {
        return bytes(
          200,
          "OK",
          "application/json",
          "utf-8",
          fallback,
          headers(
            "x-feed-source",
            "adsb.lol",
            "x-flight-source",
            "adsb.lol",
            "x-flight-coverage",
            "250 nm point snapshot",
            "x-opensky-cache",
            "FALLBACK"
          )
        );
      }
    }

    return json(
      502,
      "Bad Gateway",
      "{\"error\":\"flights_unavailable\"}",
      headers("Cache-Control", "no-store")
    );
  }

  /**
   * Map a readsb snapshot to OpenSky state vectors, the order the client reads:
   * icao24, callsign, origin country, position time, last contact, longitude,
   * latitude, baro altitude, on ground, velocity, true track, vertical rate,
   * sensors, geo altitude, squawk, spi, source, category.
   */
  private static byte[] adsbLolSnapshot(String lat, String lon) {
    try {
      double latitude = Double.parseDouble(lat);
      double longitude = Double.parseDouble(lon);
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
      String url = String.format(
        Locale.US,
        "https://api.adsb.lol/v2/lat/%.2f/lon/%.2f/dist/250",
        latitude,
        longitude
      );
      JSONObject payload = new JSONObject(new String(get(url), StandardCharsets.UTF_8));
      JSONArray aircraft = payload.optJSONArray("ac");
      if (aircraft == null) return null;
      long nowS = System.currentTimeMillis() / 1000;
      JSONArray states = new JSONArray();
      for (int i = 0; i < aircraft.length(); i += 1) {
        JSONObject row = aircraft.optJSONObject(i);
        if (row == null) continue;
        String hex = row.optString("hex", "").toLowerCase(Locale.ROOT);
        if (hex.isEmpty() || row.isNull("lat") || row.isNull("lon")) continue;
        Double seen = optDouble(row, "seen_pos");
        Double contact = optDouble(row, "seen");
        String altBaro = row.optString("alt_baro", "");
        boolean ground = "ground".equalsIgnoreCase(altBaro);
        Double baroFt = optDouble(row, "alt_baro");
        Double geoFt = optDouble(row, "alt_geom");
        Double speedKt = optDouble(row, "gs");
        Double trackDeg = optDouble(row, "track");
        Double rateFtMin = optDouble(row, "baro_rate");
        JSONArray state = new JSONArray();
        state.put(hex);
        state.put(row.optString("flight", "").trim());
        state.put("");
        state.put(seen == null ? JSONObject.NULL : nowS - seen.longValue());
        state.put(contact == null ? JSONObject.NULL : nowS - contact.longValue());
        state.put(optDouble(row, "lon"));
        state.put(optDouble(row, "lat"));
        state.put(ground ? 0.0 : (baroFt == null ? null : baroFt * 0.3048));
        state.put(ground);
        state.put(speedKt == null ? JSONObject.NULL : speedKt * 0.514444);
        state.put(trackDeg == null ? JSONObject.NULL : trackDeg);
        state.put(rateFtMin == null ? JSONObject.NULL : rateFtMin * 0.00508);
        state.put(JSONObject.NULL);
        state.put(geoFt == null ? JSONObject.NULL : geoFt * 0.3048);
        state.put(row.optString("squawk", ""));
        state.put(false);
        state.put(1);
        String category = row.optString("category", "");
        state.put(
          category.matches("[AB]\\d")
            ? Integer.parseInt(category.substring(1))
            : JSONObject.NULL
        );
        states.put(state);
      }
      JSONObject out = new JSONObject();
      out.put("time", nowS);
      out.put("states", states);
      return out.toString().getBytes(StandardCharsets.UTF_8);
    } catch (IOException | JSONException | NumberFormatException failure) {
      Log.w(TAG, "adsb.lol fallback failed: " + failure.getMessage());
      return null;
    }
  }

  private static WebResourceResponse track(String rawIcao) throws IOException {
    String hex = rawIcao == null ? "" : rawIcao.trim().toLowerCase(Locale.ROOT);
    if (!hex.matches("[0-9a-f]{6}")) {
      return json(400, "Bad Request", "{\"error\":\"invalid_icao24\"}", headers());
    }
    Cached entry = cache.get("track:" + hex);
    if (entry == null || entry.ageMs() >= TRACK_TTL_MS) {
      try {
        byte[] body = get(
          "https://opensky-network.org/api/tracks/all?icao24=" + hex + "&time=0"
        );
        if (isJson(body)) {
          entry = new Cached(body);
          remember("track:" + hex, entry);
        }
      } catch (IOException failure) {
        if (entry == null) throw failure;
      }
    }
    if (entry == null) {
      return json(
        502,
        "Bad Gateway",
        "{\"error\":\"track_unavailable\"}",
        headers("Cache-Control", "no-store")
      );
    }
    return bytes(200, "OK", "application/json", "utf-8", entry.body, headers());
  }

  /* ── community military feeds and adsbdb enrichment ─────────────────── */

  /**
   * The military feeds this shell reads, merged the way the project's server
   * merges them (server/providers/aircraft/military-feeds.js): each network is
   * a different set of receivers, so the same minute of sky comes back
   * overlapping AND different.
   *
   * <p>The keyed feeds the server can read stay out of the APK. A key compiled
   * into a public download is a published key, which is exactly the mistake the
   * hard-coded traffic key already demonstrates.
   */
  private static final String[][] MILITARY_FEEDS = {
    { "adsb.lol", "https://api.adsb.lol/v2/mil" },
    { "adsb.fi", "https://opendata.adsb.fi/api/v2/mil" },
  };

  private static final long MILITARY_TTL_MS = 12_000L;

private static WebResourceResponse military() {
  Map<String, JSONObject> byIcao = new HashMap<>();
  JSONArray unkeyed = new JSONArray();
  List<String> answered = new ArrayList<>();
  // Per-feed counts in the same shape the server reports them, so the two
  // implementations of this route can be compared header for header.
  List<String> reported = new ArrayList<>();
  for (int index = 0; index < MILITARY_FEEDS.length; index += 1) {
    String id = MILITARY_FEEDS[index][0];
    String key = "mil:" + id;
    Cached entry = cache.get(key);
    if (entry == null || entry.ageMs() >= MILITARY_TTL_MS) {
      try {
        byte[] body = get(MILITARY_FEEDS[index][1]);
        if (isJson(body)) {
          entry = new Cached(body);
          remember(key, entry);
        }
      } catch (IOException failure) {
        // One feed down never costs the others their data: a shell that still
        // has a cached copy serves it, and only a shell with nothing at all
        // answers 502 below.
        if (entry == null) continue;
      }
    }
    if (entry == null) continue;
    JSONArray aircraft = militaryAircraft(entry.body);
    if (aircraft == null) continue;
    answered.add(id);
    int count = 0;
    for (int row = 0; row < aircraft.length(); row += 1) {
      JSONObject contact = aircraft.optJSONObject(row);
      if (contact == null) continue;
      count += 1;
      String icao = contact.optString("hex", "").trim().toLowerCase(Locale.ROOT);
      if (icao.isEmpty()) {
        // No identity to deduplicate on: keep the row as received.
        unkeyed.put(contact);
        continue;
      }
      // The ICAO24 is the row's identity, so the merged answer spells it one
      // way however the feed that won happened to write it.
      try {
        contact.put("hex", icao);
      } catch (JSONException impossible) {
        // Storing a string cannot fail; org.json declares the exception anyway.
        Log.w(TAG, "military row kept its original ICAO24 spelling", impossible);
      }
      JSONObject incumbent = byIcao.get(icao);
      if (incumbent == null || preferredMilitaryRow(contact, incumbent)) {
        byIcao.put(icao, contact);
      }
    }
    reported.add(id + "=" + count);
  }
  if (answered.isEmpty()) {
    return json(
      502,
      "Bad Gateway",
      "{\"error\":\"military_unavailable\"}",
      headers("Cache-Control", "no-store")
    );
  }
  JSONArray ac = new JSONArray();
  for (JSONObject contact : byIcao.values()) ac.put(contact);
  for (int row = 0; row < unkeyed.length(); row += 1) ac.put(unkeyed.opt(row));
  try {
    JSONObject merged = new JSONObject();
    merged.put("ac", ac);
    merged.put("total", ac.length());
    return bytes(
      200,
      "OK",
      "application/json",
      "utf-8",
      merged.toString().getBytes(StandardCharsets.UTF_8),
      headers(
        "x-feed-source",
        String.join("+", answered),
        "x-military-sources",
        String.join(",", reported)
      )
    );
  } catch (JSONException failure) {
    return json(
      502,
      "Bad Gateway",
      "{\"error\":\"military_unavailable\"}",
      headers()
    );
  }
}

/** The `ac` array of a readsb body, or null when the body is not one. */
private static JSONArray militaryAircraft(byte[] body) {
  try {
    JSONObject payload = new JSONObject(
      new String(body, StandardCharsets.UTF_8)
    );
    return payload.optJSONArray("ac");
  } catch (JSONException notAnObject) {
    return null;
  }
}

/**
 * Does `candidate` describe one aircraft better than `incumbent`?
 *
 * <p>A row with a position always wins: the aircraft layers drop a positionless
 * contact, so keeping one would delete the very aircraft the merge is widening
 * coverage for. Between two positioned rows the freshest observation wins, and
 * a tie keeps the incumbent so the answer is stable between refreshes.
 */
private static boolean preferredMilitaryRow(
  JSONObject candidate,
  JSONObject incumbent
) {
  boolean candidatePositioned = militaryPositioned(candidate);
  if (candidatePositioned != militaryPositioned(incumbent)) {
    return candidatePositioned;
  }
  double candidateSeen = militarySeenPosition(candidate);
  double incumbentSeen = militarySeenPosition(incumbent);
  if (Double.isNaN(candidateSeen)) return false;
  if (Double.isNaN(incumbentSeen)) return true;
  return candidateSeen < incumbentSeen;
}

private static boolean militaryPositioned(JSONObject contact) {
  double latitude = contact.optDouble("lat", Double.NaN);
  double longitude = contact.optDouble("lon", Double.NaN);
  return (
    !Double.isNaN(latitude) &&
    !Double.isNaN(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

/** Seconds since the position was observed, or NaN when the row omits it. */
private static double militarySeenPosition(JSONObject contact) {
  return contact.has("seen_pos")
    ? contact.optDouble("seen_pos", Double.NaN)
    : Double.NaN;
}

private static WebResourceResponse enrichment(String tail) throws IOException {
  if (!tail.matches("(callsign|aircraft)/[A-Za-z0-9]{1,10}")) {
    return json(400, "Bad Request", "{\"error\":\"invalid_lookup\"}", headers());
  }
  Cached entry = cache.get("adsbdb:" + tail);
  if (entry == null || entry.ageMs() >= 3600_000L) {
    try {
      byte[] body = get("https://api.adsbdb.com/v0/" + tail);
      if (isJson(body)) {
        entry = new Cached(body);
        remember("adsbdb:" + tail, entry);
      }
    } catch (IOException failure) {
      if (entry == null) throw failure;
    }
  }
  if (entry == null) {
    return json(
      502,
      "Bad Gateway",
      "{\"error\":\"enrichment_unavailable\"}",
      headers("Cache-Control", "no-store")
    );
  }
  return bytes(200, "OK", "application/json", "utf-8", entry.body, headers());
}

/* ── Launch Library 2 ───────────────────────────────────────────────── */

  private static WebResourceResponse launches() throws IOException {
    Cached entry = cache.get("ll2:recent");
    if (entry == null || entry.ageMs() >= LAUNCHES_TTL_MS) {
      long now = System.currentTimeMillis();
      String start = isoUtc(now - 30L * 86_400_000L);
      String end = isoUtc(now);
      String url =
        "https://ll.thespacedevs.com/2.3.0/launches/?net__gte=" +
          URLEncoder.encode(start, "UTF-8") +
          "&net__lte=" +
          URLEncoder.encode(end, "UTF-8") +
          "&limit=100&mode=detailed";
      byte[] body;
      try {
        body = get(url);
      } catch (IOException failure) {
        if (entry == null) throw failure;
        return bytes(200, "OK", "application/json", "utf-8", entry.body, headers());
      }
      if (isJson(body)) {
        entry = new Cached(body);
        remember("ll2:recent", entry);
      }
    }
    if (entry == null) {
      return json(
        502,
        "Bad Gateway",
        "{\"error\":\"launches_unavailable\"}",
        headers("Cache-Control", "no-store")
      );
    }
    return bytes(200, "OK", "application/json", "utf-8", entry.body, headers());
  }

  /* ── TomTom traffic ─────────────────────────────────────────────────── */

  private static WebResourceResponse tomtomStatus() {
    JSONObject out = new JSONObject();
    try {
      out.put("hasKey", TOMTOM_KEY != null && !TOMTOM_KEY.isEmpty());
      out.put("dailyCount", 0);
      out.put("budget", TOMTOM_DAILY_BUDGET);
      out.put("date", isoUtc(System.currentTimeMillis()).substring(0, 10));
    } catch (JSONException ignored) {
      // Never thrown for these primitive keys.
    }
    return json(200, "OK", out.toString(), headers());
  }

  private static WebResourceResponse tomtomFlow(String path) {
    if (TOMTOM_KEY == null || TOMTOM_KEY.isEmpty()) {
      return json(
        503,
        "Service Unavailable",
        "{\"error\":\"no_key\"}",
        headers("Cache-Control", "no-store")
      );
    }
    String sub = path.substring("/api/tomtom/flow/".length());
    String cacheKey = "tt:flow:" + sub;
    Cached entry = cache.get(cacheKey);
    if (entry != null && entry.ageMs() < TOMTOM_TILE_TTL_MS) {
      return bytes(200, "OK", "application/x-protobuf", "binary", entry.body, headers("x-tomtom-cache", "HIT"));
    }
    String upstreamUrl = "https://api.tomtom.com/traffic/map/4/tile/flow/relative/" + sub + "?key=" + TOMTOM_KEY;
    try {
      byte[] body = get(upstreamUrl);
      if (body != null && body.length > 0) {
        entry = new Cached(body);
        remember(cacheKey, entry);
        return bytes(200, "OK", "application/x-protobuf", "binary", body, headers("x-tomtom-cache", "MISS"));
      }
    } catch (IOException e) {
      Log.w(TAG, "TomTom flow tile failed for " + sub + ": " + e.getMessage());
    }
    return json(502, "Bad Gateway", "{\"error\":\"upstream\"}", headers());
  }

  /* ── NOAA nowCOAST Weather Radar, Clouds and Lightning Tiles ─────────── */

  private static final byte[] BLANK_PNG_256 = android.util.Base64.decode(
    "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAABFUlEQVR4nO3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMBPAABPO1TCQAAAABJRU5ErkJggg==",
    android.util.Base64.DEFAULT
  );

  private static final Map<String, WeatherSpec> WEATHER_SPECS = new HashMap<>();
  static {
    WEATHER_SPECS.put("radar", new WeatherSpec(
      "weather_radar",
      "conus_base_reflectivity_mosaic",
      "weather_radar_base_reflectivity",
      "-130,20,-60,55",
      -130.0, 20.0, -60.0, 55.0,
      4096, 2048
    ));
    WEATHER_SPECS.put("clouds", new WeatherSpec(
      "satellite",
      "global_longwave_imagery_mosaic",
      "reflectance",
      "-180,-90,180,90",
      -180.0, -90.0, 180.0, 90.0,
      2048, 1024
    ));
    WEATHER_SPECS.put("clouds-regional", new WeatherSpec(
      "satellite",
      "goes_longwave_imagery",
      "goes-lir",
      "-180,-90,180,90",
      -180.0, -90.0, 180.0, 90.0,
      4096, 2048
    ));
    WEATHER_SPECS.put("lightning", new WeatherSpec(
      "lightning_detection",
      "ldn_lightning_strike_density",
      "lightning_density",
      "-180,-25,0,80",
      -180.0, -25.0, 0.0, 80.0,
      4096, 2048
    ));
  }

  private static class WeatherSpec {
    final String service;
    final String layer;
    final String style;
    final String defaultBbox;
    final double minLon;
    final double minLat;
    final double maxLon;
    final double maxLat;
    final int defaultWidth;
    final int defaultHeight;

    WeatherSpec(
      String service,
      String layer,
      String style,
      String defaultBbox,
      double minLon,
      double minLat,
      double maxLon,
      double maxLat,
      int defaultWidth,
      int defaultHeight
    ) {
      this.service = service;
      this.layer = layer;
      this.style = style;
      this.defaultBbox = defaultBbox;
      this.minLon = minLon;
      this.minLat = minLat;
      this.maxLon = maxLon;
      this.maxLat = maxLat;
      this.defaultWidth = defaultWidth;
      this.defaultHeight = defaultHeight;
    }
  }

  private static WebResourceResponse weatherTile(Map<String, String> params) {
    String product = params.get("product");
    if (product == null || product.isEmpty()) product = "radar";
    WeatherSpec spec = WEATHER_SPECS.get(product);
    if (spec == null) spec = WEATHER_SPECS.get("radar");

    String time = params.get("time");
    if (time == null || time.isEmpty()) time = "latest";

    int z = 0, x = 0, y = 0;
    try {
      if (params.containsKey("z")) z = Integer.parseInt(params.get("z"));
      if (params.containsKey("x")) x = Integer.parseInt(params.get("x"));
      if (params.containsKey("y")) y = Integer.parseInt(params.get("y"));
    } catch (NumberFormatException ignored) {}

    double span = 180.0 / Math.pow(2, z);
    double west = -180.0 + x * span;
    double south = 90.0 - (y + 1) * span;
    double east = -180.0 + (x + 1) * span;
    double north = 90.0 - y * span;

    // If tile does not intersect product coverage, return transparent tile
    if (east < spec.minLon || west > spec.maxLon || north < spec.minLat || south > spec.maxLat) {
      return bytes(200, "OK", "image/png", null, BLANK_PNG_256, headers("Cache-Control", "public, max-age=86400, immutable"));
    }

    String bbox = west + "," + south + "," + east + "," + north;
    String cacheKey = "wtile:" + product + ":" + time + ":" + z + ":" + x + ":" + y;
    Cached entry = cache.get(cacheKey);
    if (entry != null && entry.ageMs() < 86400_000L) {
      return bytes(200, "OK", "image/png", null, entry.body, headers("Cache-Control", "public, max-age=86400, immutable"));
    }

    try {
      String encodedTime = URLEncoder.encode(time, "UTF-8");
      String wmsUrl = "https://nowcoast.noaa.gov/geoserver/observations/" + spec.service +
        "/ows?service=WMS&version=1.1.1&request=GetMap&layers=" + spec.layer +
        "&styles=" + spec.style +
        "&srs=EPSG:4326&bbox=" + bbox +
        "&width=256&height=256&format=image/png&transparent=true&time=" + encodedTime;
      byte[] body = get(wmsUrl);
      if (body != null && body.length >= 8 &&
          body[0] == (byte) 0x89 && body[1] == (byte) 0x50 && body[2] == (byte) 0x4E && body[3] == (byte) 0x47) {
        entry = new Cached(body);
        remember(cacheKey, entry);
        return bytes(200, "OK", "image/png", null, body, headers("Cache-Control", "public, max-age=86400, immutable"));
      }
    } catch (Exception e) {
      Log.w(TAG, "Weather tile fetch failed for " + product + ": " + e.getMessage());
    }

    return bytes(200, "OK", "image/png", null, BLANK_PNG_256, headers("Cache-Control", "public, max-age=300"));
  }

  private static WebResourceResponse weatherImage(Map<String, String> params) {
    String product = params.get("product");
    if (product == null || product.isEmpty()) product = "radar";
    WeatherSpec spec = WEATHER_SPECS.get(product);
    if (spec == null) spec = WEATHER_SPECS.get("radar");

    String time = params.get("time");
    if (time == null || time.isEmpty()) time = "latest";

    String bbox = params.get("bbox");
    if (bbox == null || bbox.isEmpty()) bbox = spec.defaultBbox;

    int width = spec.defaultWidth;
    int height = spec.defaultHeight;
    String sizeStr = params.get("size");
    if (sizeStr != null && sizeStr.contains("x")) {
      String[] parts = sizeStr.split("x");
      try {
        width = Integer.parseInt(parts[0]);
        height = Integer.parseInt(parts[1]);
      } catch (NumberFormatException ignored) {}
    } else {
      try {
        if (params.containsKey("width")) width = Integer.parseInt(params.get("width"));
        if (params.containsKey("height")) height = Integer.parseInt(params.get("height"));
      } catch (NumberFormatException ignored) {}
    }

    String cacheKey = "wimg:" + product + ":" + time + ":" + bbox + ":" + width + "x" + height;
    Cached entry = cache.get(cacheKey);
    if (entry != null && entry.ageMs() < 86400_000L) {
      return bytes(200, "OK", "image/png", null, entry.body, headers("Cache-Control", "public, max-age=86400, immutable"));
    }

    try {
      String encodedTime = URLEncoder.encode(time, "UTF-8");
      String wmsUrl = "https://nowcoast.noaa.gov/geoserver/observations/" + spec.service +
        "/ows?service=WMS&version=1.1.1&request=GetMap&layers=" + spec.layer +
        "&styles=" + spec.style +
        "&srs=EPSG:4326&bbox=" + bbox +
        "&width=" + width + "&height=" + height +
        "&format=image/png&transparent=true&time=" + encodedTime;
      byte[] body = get(wmsUrl);
      if (body != null && body.length >= 8 &&
          body[0] == (byte) 0x89 && body[1] == (byte) 0x50 && body[2] == (byte) 0x4E && body[3] == (byte) 0x47) {
        entry = new Cached(body);
        remember(cacheKey, entry);
        return bytes(200, "OK", "image/png", null, body, headers("Cache-Control", "public, max-age=86400, immutable"));
      }
    } catch (Exception e) {
      Log.w(TAG, "Weather image fetch failed for " + product + ": " + e.getMessage());
    }

    return bytes(200, "OK", "image/png", null, BLANK_PNG_256, headers("Cache-Control", "public, max-age=300"));
  }

  /* ── Bounded read-through for the in-page adapters ───────────────────── */

  private static WebResourceResponse upstream(String raw, boolean binary)
    throws IOException {
    if (raw == null || raw.isEmpty()) {
      return json(400, "Bad Request", "{\"error\":\"missing_url\"}", headers());
    }
    URL url;
    try {
      url = new URL(raw);
    } catch (MalformedURLException failure) {
      return json(400, "Bad Request", "{\"error\":\"invalid_url\"}", headers());
    }
    if (!"https".equals(url.getProtocol()) || !upstreamHostAllowed(url.getHost())) {
      return json(403, "Forbidden", "{\"error\":\"host_not_allowed\"}", headers());
    }
    Cached entry = cache.get("upstream:" + raw);
    if (entry != null && entry.ageMs() < UPSTREAM_TTL_MS) {
      return upstreamBody(entry.body, binary, "HIT");
    }
    byte[] body = null;
    try {
      body = getUpstream(raw);
    } catch (IOException failure) {
      if (entry == null) throw failure;
    }
    if (body == null || body.length == 0 || body.length > UPSTREAM_MAX_BYTES) {
      if (entry == null) {
        return json(
          502,
          "Bad Gateway",
          "{\"error\":\"upstream_unavailable\"}",
          headers()
        );
      }
      return upstreamBody(entry.body, binary, "STALE");
    }
    remember("upstream:" + raw, new Cached(body));
    return upstreamBody(body, binary, "MISS");
  }

  /**
   * Hand one read-through body back as the caller asked for it.
   *
   * A protobuf feed (GTFS-Realtime) cannot travel as text: telling the WebView
   * the type is JSON makes it decode the bytes as UTF-8 before the page can
   * read them. `binary=1` therefore answers octet-stream with no charset, so
   * the body reaches the page as the bytes the operator sent.
   */
  private static WebResourceResponse upstreamBody(
    byte[] body,
    boolean binary,
    String cache
  ) {
    Map<String, String> out = headers("x-upstream-cache", cache);
    return binary
      ? bytes(200, "OK", "application/octet-stream", null, body, out)
      : bytes(200, "OK", "application/json", "utf-8", body, out);
  }

  private static boolean upstreamHostAllowed(String host) {
    if (host == null) return false;
    String lower = host.toLowerCase(Locale.ROOT);
    if (lower.endsWith(".publicbikesystem.net")) return true;
    for (String allowed : UPSTREAM_HOSTS) {
      if (allowed.equalsIgnoreCase(host)) return true;
    }
    return false;
  }

  /* ── Transport and small helpers ────────────────────────────────────── */

  /**
   * Read one allowlisted host, following a few redirects that stay on it.
   *
   * The fixed host list is what keeps this route from being a general proxy,
   * and a redirect only keeps that promise when it does not leave the host
   * that was checked. Operators do redirect inside their own tree — the
   * Texas Socrata endpoint answers 302 to its own /api/views path for the
   * CapMetro feed — so a same-host hop is followed and anything else refused.
   */
  private static byte[] getUpstream(String target) throws IOException {
    String host = new URL(target).getHost();
    String current = target;
    for (int hop = 0; hop <= UPSTREAM_MAX_REDIRECTS; hop += 1) {
      HttpURLConnection connection = null;
      try {
        connection = (HttpURLConnection) new URL(current).openConnection();
        connection.setRequestMethod("GET");
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestProperty("User-Agent", USER_AGENT);
        connection.setRequestProperty("Accept", "*/*");
        connection.setRequestProperty("Accept-Encoding", "identity");
        int status = connection.getResponseCode();
        if (status >= 300 && status < 400) {
          String location = connection.getHeaderField("Location");
          URL next = location == null
            ? null
            : new URL(new URL(current), location);
          if (
            next == null ||
            !"https".equals(next.getProtocol()) ||
            !host.equalsIgnoreCase(next.getHost()) ||
            !upstreamHostAllowed(next.getHost())
          ) {
            throw new IOException("redirect refused");
          }
          current = next.toString();
          continue;
        }
        if (status != 200) throw new IOException("HTTP " + status);
        InputStream stream = connection.getInputStream();
        if (stream == null) throw new IOException("HTTP " + status);
        try {
          ByteArrayOutputStream out = new ByteArrayOutputStream();
          byte[] buffer = new byte[16 * 1024];
          int read;
          while ((read = stream.read(buffer)) != -1) {
            out.write(buffer, 0, read);
            if (out.size() > UPSTREAM_MAX_BYTES)
              throw new IOException("body too large");
          }
          return out.toByteArray();
        } finally {
          stream.close();
        }
      } finally {
        if (connection != null) connection.disconnect();
      }
    }
    throw new IOException("too many redirects");
  }

  private static byte[] get(String target) throws IOException {
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(target).openConnection();
      connection.setRequestMethod("GET");
      connection.setInstanceFollowRedirects(true);
      connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
      connection.setReadTimeout(READ_TIMEOUT_MS);
      connection.setRequestProperty("User-Agent", USER_AGENT);
      connection.setRequestProperty("Accept", "application/json, text/plain, */*");
      // HttpURLConnection does not inflate for us; ask for the raw body.
      connection.setRequestProperty("Accept-Encoding", "identity");
      int status = connection.getResponseCode();
      InputStream stream = status >= 400
        ? connection.getErrorStream()
        : connection.getInputStream();
      if (stream == null) throw new IOException("HTTP " + status);
      try {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int read;
        while ((read = stream.read(buffer)) != -1) out.write(buffer, 0, read);
        if (status >= 400) throw new IOException("HTTP " + status);
        return out.toByteArray();
      } finally {
        stream.close();
      }
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  private static boolean isJson(byte[] body) {
    if (body == null || body.length < 2) return false;
    try {
      new JSONObject(new String(body, StandardCharsets.UTF_8));
      return true;
    } catch (JSONException notObject) {
      try {
        new JSONArray(new String(body, StandardCharsets.UTF_8));
        return true;
      } catch (JSONException notArray) {
        return false;
      }
    }
  }

  private static void remember(String key, Cached entry) {
    if (cache.size() >= MAX_CACHE_ENTRIES && !cache.containsKey(key)) {
      Iterator<String> keys = cache.keySet().iterator();
      if (keys.hasNext()) cache.remove(keys.next());
    }
    cache.put(key, entry);
  }

  private static String trimTrailing(String path) {
    int end = path.length();
    while (end > 1 && path.charAt(end - 1) == '/') end -= 1;
    return path.substring(0, end);
  }

  private static String isoUtc(long epochMs) {
    java.text.SimpleDateFormat format = new java.text.SimpleDateFormat(
      "yyyy-MM-dd'T'HH:mm:ss'Z'",
      Locale.US
    );
    format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
    return format.format(new java.util.Date(epochMs));
  }

  private static Double optDouble(JSONObject object, String key) {
    if (!object.has(key) || object.isNull(key)) return null;
    double value = object.optDouble(key, Double.NaN);
    return Double.isNaN(value) ? null : value;
  }

  private static Map<String, String> parseQuery(String query) {
    Map<String, String> out = new HashMap<>();
    if (query == null || query.isEmpty()) return out;
    for (String pair : query.split("&")) {
      int split = pair.indexOf('=');
      if (split <= 0) continue;
      try {
        out.put(
          java.net.URLDecoder.decode(pair.substring(0, split), "UTF-8"),
          java.net.URLDecoder.decode(pair.substring(split + 1), "UTF-8")
        );
      } catch (java.io.UnsupportedEncodingException ignored) {
        // UTF-8 always exists.
      }
    }
    return out;
  }

  private static String healthJson() {
    return "{\"ok\":true,\"service\":\"gods-eye-view android live api\",\"routes\":" +
      "[\"/api/celestrak/{group}\",\"/api/flights\",\"/api/opensky\"," +
      "\"/api/flights/track?icao24={hex}\",\"/api/military\",\"/api/adsbdb/{kind}/{id}\"," +
      "\"/api/launches\",\"/api/tomtom/status\",\"/api/upstream?url={https}\"]}";
  }

  private static Map<String, String> headers(String... pairs) {
    Map<String, String> out = new HashMap<>();
    out.put("Cache-Control", "no-store");
    for (int i = 0; i + 1 < pairs.length; i += 2) out.put(pairs[i], pairs[i + 1]);
    return out;
  }

  private static WebResourceResponse json(
    int status,
    String reason,
    String body,
    Map<String, String> headers
  ) {
    return bytes(
      status,
      reason,
      "application/json",
      "utf-8",
      body.getBytes(StandardCharsets.UTF_8),
      headers
    );
  }

  private static WebResourceResponse bytes(
    int status,
    String reason,
    String mime,
    String encoding,
    byte[] body,
    Map<String, String> headers
  ) {
    return new WebResourceResponse(
      mime,
      encoding,
      status,
      reason,
      headers,
      new ByteArrayInputStream(body)
    );
  }

  private static String quote(String value) {
    StringBuilder out = new StringBuilder("\"");
    for (int i = 0; i < value.length(); i += 1) {
      char c = value.charAt(i);
      if (c == '"' || c == '\\') out.append('\\');
      out.append(c);
    }
    return out.append('"').toString();
  }

  /** One cached upstream body with the moment it arrived. */
  private static final class Cached {

    final byte[] body;
    final long at;

    Cached(byte[] body) {
      this.body = body;
      this.at = System.currentTimeMillis();
    }

    long ageMs() {
      return System.currentTimeMillis() - at;
    }
  }
}
