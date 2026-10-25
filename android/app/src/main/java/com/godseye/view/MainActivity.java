package com.godseye.view;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.app.Activity;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Single-Activity shell for the God's Eye View console.
 *
 * <p>The Vite build is shipped inside the APK under {@code assets/www}. Serving
 * it from a real https origin (rather than {@code file://}) keeps module
 * imports, workers, localStorage and getUserMedia working, which is what the
 * console needs. Requests for that origin are answered straight from the asset
 * store, so the app boots and renders with no server and no network.
 */
public class MainActivity extends Activity {

  private static final String TAG = "GodsEyeView";
  private static final String ASSET_HOST = "appassets.androidplatform.net";
  private static final String START_URL = "https://" + ASSET_HOST + "/index.html";
  private static final int REQUEST_MIC = 41;
  private static final int REQUEST_LOCATION = 42;

  private WebView webView;
  private PermissionRequest pendingAudioRequest;
  private GeolocationPermissions.Callback pendingLocationCallback;
  private String pendingLocationOrigin;
  private ApiForwarder apiForwarder;

  @SuppressLint("SetJavaScriptEnabled")
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    getWindow().setStatusBarColor(Color.parseColor("#05080A"));
    getWindow().setNavigationBarColor(Color.parseColor("#05080A"));

    webView = new WebView(this);
    webView.setLayoutParams(
      new ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT
      )
    );
    webView.setBackgroundColor(Color.parseColor("#05080A"));
    setContentView(webView);

    // Empty when the build carries no data server: the live layers then read
    // their public feeds through LiveApi, inside the app.
    apiForwarder = new ApiForwarder(BuildConfig.API_BASE);
    Log.i(
      TAG,
      apiForwarder.isEnabled()
        ? "Data server: " + apiForwarder.describe()
        : "Data server: in-app live API (celestrak, flights, launches)"
    );

    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(true);
    settings.setGeolocationEnabled(true);
    settings.setMediaPlaybackRequiresUserGesture(false);
    settings.setAllowFileAccess(false);
    settings.setAllowContentAccess(false);
    settings.setSupportZoom(false);
    settings.setBuiltInZoomControls(false);
    settings.setDisplayZoomControls(false);
    settings.setLoadWithOverviewMode(false);
    settings.setUseWideViewPort(true);
    settings.setCacheMode(WebSettings.LOAD_DEFAULT);
    settings.setJavaScriptCanOpenWindowsAutomatically(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      settings.setSafeBrowsingEnabled(false);
    }

    webView.setWebViewClient(new AssetClient());
    webView.setWebChromeClient(new ChromeClient());
    webView.addJavascriptInterface(new NativeBridge(), "GodsEyeNative");

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
      WebView.setWebContentsDebuggingEnabled(true);
    }

    if (savedInstanceState == null) {
      webView.loadUrl(START_URL);
    } else {
      webView.restoreState(savedInstanceState);
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
        android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
        () -> {
          if (webView != null && webView.canGoBack()) {
            webView.goBack();
          } else {
            finish();
          }
        }
      );
    }
  }

  @Override
  protected void onPause() {
    super.onPause();
    if (webView != null) {
      webView.onPause();
      webView.pauseTimers();
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    if (webView != null) {
      webView.onResume();
      webView.resumeTimers();
    }
  }

  @Override
  protected void onSaveInstanceState(Bundle outState) {
    super.onSaveInstanceState(outState);
    if (webView != null) webView.saveState(outState);
  }

  @Override
  public void onBackPressed() {
    if (webView != null && webView.canGoBack()) {
      webView.goBack();
      return;
    }
    super.onBackPressed();
  }

  @Override
  protected void onDestroy() {
    if (webView != null) {
      webView.stopLoading();
      webView.destroy();
      webView = null;
    }
    super.onDestroy();
  }

  private boolean hasMic() {
    return checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED;
  }

  private void ensureMic() {
    if (hasMic()) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_MIC);
    }
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(requestCode, permissions, results);
    if (requestCode == REQUEST_MIC) {
      PermissionRequest request = pendingAudioRequest;
      pendingAudioRequest = null;
      if (request != null) {
        if (hasMic()) request.grant(request.getResources());
        else request.deny();
      }
      return;
    }
    if (requestCode == REQUEST_LOCATION) {
      GeolocationPermissions.Callback callback = pendingLocationCallback;
      String origin = pendingLocationOrigin;
      pendingLocationCallback = null;
      pendingLocationOrigin = null;
      if (callback != null && origin != null) {
        // retain=false: the page asks again next launch, so a later "deny" in
        // Android settings is not overruled by a remembered grant.
        callback.invoke(origin, hasLocation(), false);
      }
    }
  }

  /**
   * Whether the system location permission is already held. The page's locate
   * button asks the other way round: the WebView prompt reaches us first, and
   * this is what decides whether to answer it or to ask the user.
   */
  private boolean hasLocation() {
    return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED ||
      checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) ==
      PackageManager.PERMISSION_GRANTED;
  }

  private void ensureLocation() {
    if (hasLocation()) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      // Both, so the user may answer with the approximate fix and the marker
      // still lands on their block.
      requestPermissions(
        new String[] {
          Manifest.permission.ACCESS_FINE_LOCATION,
          Manifest.permission.ACCESS_COARSE_LOCATION,
        },
        REQUEST_LOCATION
      );
    }
  }

  /** Answers the app's origin from the packaged build. */
  private final class AssetClient extends WebViewClient {
    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
      if (request == null || request.getUrl() == null) return null;
      if (!ASSET_HOST.equals(request.getUrl().getHost())) return null;
      String path = request.getUrl().getPath();
      if (apiForwarder != null && apiForwarder.handles(path)) {
        WebResourceResponse forwarded = apiForwarder.forward(request);
        WebResourceResponse rescue = rescueLocally(request, path, forwarded);
        return rescue != null ? rescue : forwarded;
      }
      if (LiveApi.handles(path)) {
        WebResourceResponse local = LiveApi.serve(request);
        if (local != null) return local;
      }
      return serveAsset(path);
    }

    /**
     * Re-serves a request the hosted server failed, from the shell's own client.
     *
     * <p>A hosted copy of this project is the primary data source, but it cannot
     * always reach an upstream: CelesTrak answers a rebroadcast from a
     * datacentre address with a connect timeout, which emptied the satellites
     * layer on a phone whose own network reads the same feed fine. When the
     * server answers 5xx for a route {@link LiveApi} already serves, the shell's
     * copy is a better answer than an outage. A 4xx is a decision, not a
     * failure, so it is passed through untouched.
     *
     * @return the in-app response, or {@code null} to keep the server's answer.
     */
    private WebResourceResponse rescueLocally(
      WebResourceRequest request,
      String path,
      WebResourceResponse forwarded
    ) {
      if (forwarded == null || forwarded.getStatusCode() < 500) return null;
      String method = request.getMethod() == null ? "GET" : request.getMethod().toUpperCase(Locale.ROOT);
      if (!"GET".equals(method) && !"HEAD".equals(method)) return null;
      if (!LiveApi.handles(path)) return null;
      WebResourceResponse local = LiveApi.serve(request);
      if (local == null || local.getStatusCode() >= 500) return null;
      Log.i(
        TAG,
        "Data server answered " + forwarded.getStatusCode() + " for " + path +
          "; served it in-app instead"
      );
      return local;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      if (request == null || request.getUrl() == null) return false;
      // Everything the console loads is same-origin or a normal https fetch;
      // only a genuinely external link is handed to the system browser.
      return !ASSET_HOST.equals(request.getUrl().getHost());
    }
  }

  private WebResourceResponse serveAsset(String rawPath) {
    String path = rawPath == null || rawPath.isEmpty() ? "/index.html" : rawPath;
    if (path.endsWith("/")) path = path + "index.html";

    String assetPath = "www" + path;
    try {
      InputStream stream = getAssets().open(assetPath);
      Map<String, String> headers = new HashMap<>();
      headers.put("Cache-Control", "no-cache");
      String mime = mimeType(assetPath);
      String encoding = mime.startsWith("text/") ||
        mime.equals("application/javascript") ||
        mime.equals("application/json") ||
        mime.equals("image/svg+xml")
        ? "utf-8"
        : null;
      return new WebResourceResponse(mime, encoding, 200, "OK", headers, stream);
    } catch (IOException missing) {
      return null;
    }
  }

  private static String mimeType(String path) {
    String lower = path.toLowerCase();
    if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
    if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
    if (lower.endsWith(".css")) return "text/css";
    if (lower.endsWith(".json")) return "application/json";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".ico")) return "image/x-icon";
    if (lower.endsWith(".wasm")) return "application/wasm";
    if (lower.endsWith(".glb")) return "model/gltf-binary";
    if (lower.endsWith(".gltf")) return "model/gltf+json";
    if (lower.endsWith(".woff2")) return "font/woff2";
    if (lower.endsWith(".woff")) return "font/woff";
    if (lower.endsWith(".ttf")) return "font/ttf";
    if (lower.endsWith(".xml")) return "application/xml";
    if (lower.endsWith(".txt") || lower.endsWith(".csv")) return "text/plain";
    if (lower.endsWith(".mp4")) return "video/mp4";
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    return "application/octet-stream";
  }

  /** Grants the microphone to the page and surfaces console errors to logcat. */
  private final class ChromeClient extends WebChromeClient {
    @Override
    public void onPermissionRequest(final PermissionRequest request) {
      runOnUiThread(() -> {
        boolean wantsAudio = false;
        for (String resource : request.getResources()) {
          if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) wantsAudio = true;
        }
        if (wantsAudio && !hasMic()) {
          pendingAudioRequest = request;
          ensureMic();
          return;
        }
        request.grant(request.getResources());
      });
    }

    @Override
    public void onPermissionRequestCanceled(PermissionRequest request) {
      if (pendingAudioRequest == request) pendingAudioRequest = null;
    }

    /**
     * The map's locate button. A fix needs the Android permission, not just the
     * page's: without this the WebView answers "denied" on the first press and
     * the console can only report that the position is unavailable.
     */
    @Override
    public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
      if (hasLocation()) {
        callback.invoke(origin, true, false);
        return;
      }
      pendingLocationCallback = callback;
      pendingLocationOrigin = origin;
      ensureLocation();
    }

    @Override
    public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
      Log.d(TAG, message.message() + " @" + message.lineNumber());
      return true;
    }
  }

  /** Exposes native relay capabilities to the in-app Web client. */
  public final class NativeBridge {
    @JavascriptInterface
    public String post(String path, String headersJson, String body) {
      if (apiForwarder != null && apiForwarder.isEnabled()) {
        return apiForwarder.executePost(path, headersJson, body);
      }
      return "{\"status\":503,\"error\":\"no_server\"}";
    }
  }
}
