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
import java.util.HashMap;
import java.util.Iterator;
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
    "api.adsb.lol",
    "services3.arcgis.com",
    // NHC cyclone status and its published forecast GIS layers.
    "www.nhc.noaa.gov",
    "mapservices.weather.noaa.gov",
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
      if ("/api/launches".equals(route)) {
        return launches();
      }
      if ("/api/tomtom/status".equals(trimTrailing(path))) {
        return tomtomStatus();
      }
      if (path.startsWith("/api/tomtom/flow/")) {
        return json(
          503,
          "Service Unavailable",
          "{\"error\":\"no_key\"}",
          headers("Cache-Control", "no-store")
        );
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

  /* ── adsb.lol military feed and adsbdb enrichment ───────────────────── */

private static WebResourceResponse military() throws IOException {
  Cached entry = cache.get("adsb.lol:mil");
  if (entry == null || entry.ageMs() >= 12_000L) {
    try {
      byte[] body = get("https://api.adsb.lol/v2/mil");
      if (isJson(body)) {
        entry = new Cached(body);
        remember("adsb.lol:mil", entry);
      }
    } catch (IOException failure) {
      if (entry == null) throw failure;
    }
  }
  if (entry == null) {
    return json(
      502,
      "Bad Gateway",
      "{\"error\":\"military_unavailable\"}",
      headers("Cache-Control", "no-store")
    );
  }
  return bytes(
    200,
    "OK",
    "application/json",
    "utf-8",
    entry.body,
    headers("x-feed-source", "adsb.lol")
  );
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
      out.put("hasKey", false);
      out.put("dailyCount", 0);
      out.put("budget", TOMTOM_DAILY_BUDGET);
      out.put("date", isoUtc(System.currentTimeMillis()).substring(0, 10));
    } catch (JSONException ignored) {
      // Never thrown for these primitive keys.
    }
    return json(200, "OK", out.toString(), headers());
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
        connection.setRequestProperty("Accept", "application/json");
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
