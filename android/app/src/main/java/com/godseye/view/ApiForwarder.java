package com.godseye.view;

import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Forwards the console's {@code /api/*} requests to a running copy of the
 * project's server.
 *
 * <p>The layers that carry live data (satellites, flights, traffic, CCTV, AI
 * summary) are served by the Vite middleware in {@code server/}: the client
 * only ever asks its own origin for {@code /api/...}. A standalone APK has no
 * Node process, so those requests used to fall through to the asset store and
 * come back 404. With an origin configured at build time they are replayed over
 * the network instead, which is the same proxy the desktop build talks to.
 *
 * <p>Requests are issued from Java rather than from the page, so the server's
 * source gate sees no browser {@code Origin} and no CORS preflight is involved.
 * Only bodyless methods are supported: {@link WebResourceRequest} exposes the
 * URL, method and headers but not the entity, so a POST cannot be replayed.
 */
final class ApiForwarder {

  private static final String TAG = "GodsEyeView";
  private static final String API_PREFIX = "/api/";
  private static final int CONNECT_TIMEOUT_MS = 8000;
  private static final int READ_TIMEOUT_MS = 15000;

  /** Browser context that describes the WebView, not the server call. */
  private static final String[] DROPPED_REQUEST_HEADERS = {
    "host",
    "origin",
    "referer",
    "cookie",
    "connection",
    "keep-alive",
    "accept-encoding",
    "content-length",
    "upgrade-insecure-requests",
  };

  private final String base;

  ApiForwarder(String configuredBase) {
    String trimmed = configuredBase == null ? "" : configuredBase.trim();
    while (trimmed.endsWith("/")) trimmed = trimmed.substring(0, trimmed.length() - 1);
    this.base = trimmed;
  }

  boolean isEnabled() {
    return !base.isEmpty();
  }

  String describe() {
    return base;
  }

  boolean handles(String path) {
    return isEnabled() && path != null && path.startsWith(API_PREFIX);
  }

  WebResourceResponse forward(WebResourceRequest request) {
    String method = request.getMethod() == null
      ? "GET"
      : request.getMethod().toUpperCase(Locale.ROOT);

    if ("OPTIONS".equals(method)) {
      return new WebResourceResponse(
        "text/plain",
        "utf-8",
        204,
        "No Content",
        new HashMap<String, String>(),
        new ByteArrayInputStream(new byte[0])
      );
    }
    if (!"GET".equals(method) && !"HEAD".equals(method)) {
      return error(
        501,
        "Not Implemented",
        "The standalone shell can only replay GET requests; " + method +
          " " + request.getUrl().getPath() + " needs the project's own server."
      );
    }

    String query = request.getUrl().getEncodedQuery();
    String target = base + request.getUrl().getPath() + (query == null || query.isEmpty() ? "" : "?" + query);

    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(target).openConnection();
      connection.setRequestMethod(method);
      connection.setInstanceFollowRedirects(true);
      connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
      connection.setReadTimeout(READ_TIMEOUT_MS);
      connection.setRequestProperty("Accept-Encoding", "identity");
      copyRequestHeaders(request.getRequestHeaders(), connection);

      int status = connection.getResponseCode();
      Map<String, String> headers = responseHeaders(connection);
      String mime = mimeOf(connection.getContentType());
      String encoding = isTextual(mime) ? "utf-8" : null;
      String reason = connection.getResponseMessage();
      if (reason == null || reason.isEmpty()) reason = status == 200 ? "OK" : "Status " + status;

      InputStream body;
      if ("HEAD".equals(method)) {
        body = new ByteArrayInputStream(new byte[0]);
      } else {
        InputStream upstream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        body = upstream == null ? new ByteArrayInputStream(new byte[0]) : upstream;
      }
      return new WebResourceResponse(mime, encoding, status, reason, headers, body);
    } catch (IOException failure) {
      Log.w(TAG, "API forward failed for " + target + ": " + failure.getMessage());
      if (connection != null) connection.disconnect();
      return error(
        502,
        "Bad Gateway",
        "Could not reach the data server at " + base + " (" + failure.getClass().getSimpleName() + ")."
      );
    }
  }

  private static void copyRequestHeaders(Map<String, String> from, HttpURLConnection to) {
    if (from == null) return;
    for (Map.Entry<String, String> entry : from.entrySet()) {
      String name = entry.getKey();
      if (name == null) continue;
      String lower = name.toLowerCase(Locale.ROOT);
      if (lower.startsWith("sec-fetch-") || lower.startsWith("proxy-")) continue;
      boolean dropped = false;
      for (String blocked : DROPPED_REQUEST_HEADERS) {
        if (blocked.equals(lower)) {
          dropped = true;
          break;
        }
      }
      if (dropped) continue;
      try {
        to.setRequestProperty(name, entry.getValue());
      } catch (RuntimeException restricted) {
        // A restricted header name: skipping it is safer than failing the call.
        Log.d(TAG, "Skipped request header " + name);
      }
    }
  }

  private static Map<String, String> responseHeaders(HttpURLConnection connection) {
    Map<String, String> headers = new HashMap<>();
    for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
      String name = entry.getKey();
      if (name == null || entry.getValue() == null) continue;
      String lower = name.toLowerCase(Locale.ROOT);
      if (lower.equals("transfer-encoding") || lower.equals("connection") ||
        lower.equals("keep-alive") || lower.equals("content-length")) {
        continue;
      }
      headers.put(name, String.join(", ", entry.getValue()));
    }
    return headers;
  }

  private static String mimeOf(String contentType) {
    if (contentType == null || contentType.isEmpty()) return "application/octet-stream";
    int semicolon = contentType.indexOf(';');
    String mime = semicolon < 0 ? contentType : contentType.substring(0, semicolon);
    return mime.trim().toLowerCase(Locale.ROOT);
  }

  private static boolean isTextual(String mime) {
    return mime.startsWith("text/") ||
      mime.equals("application/json") ||
      mime.equals("application/javascript") ||
      mime.equals("application/xml") ||
      mime.equals("image/svg+xml");
  }

  private static WebResourceResponse error(int status, String reason, String message) {
    Map<String, String> headers = new HashMap<>();
    headers.put("Content-Type", "application/json");
    headers.put("Cache-Control", "no-store");
    String json = "{\"error\":" + quote(message) + "}";
    return new WebResourceResponse(
      "application/json",
      "utf-8",
      status,
      reason,
      headers,
      new ByteArrayInputStream(json.getBytes(StandardCharsets.UTF_8))
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
}
