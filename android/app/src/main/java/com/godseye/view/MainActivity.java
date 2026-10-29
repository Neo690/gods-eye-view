package com.godseye.view;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.LocationManager;
import android.provider.Settings;
import android.widget.Toast;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
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
  private static final int REQUEST_FILE_CHOOSER = 43;

  private WebView webView;
  private PermissionRequest pendingAudioRequest;
  private GeolocationPermissions.Callback pendingLocationCallback;
  /** The page's file input, waiting for the system picker to answer. */
  private ValueCallback<Uri[]> pendingFileChooser;
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
    // Every provider "get a key" link is target="_blank", which the WebView
    // only delivers to onWindowCreate when multiple windows are enabled. The
    // shell shows no second window: ChromeClient hands those URLs to the
    // browser instead of dropping them.
    settings.setSupportMultipleWindows(true);
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

  /**
   * Answers a page file input with the file the operator picked.
   *
   * <p>Without this override a WebView silently ignores {@code <input
   * type="file">}: no picker, no callback, a button that does nothing. The
   * private Wi-Fi layer is built on that input, so the shell has to answer it.
   * {@code FileChooserParams.parseResult} returns null for a cancelled pick,
   * which is exactly what the page expects.
   */
  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != REQUEST_FILE_CHOOSER) return;
    ValueCallback<Uri[]> callback = pendingFileChooser;
    pendingFileChooser = null;
    if (callback == null) return;
    callback.onReceiveValue(
      WebChromeClient.FileChooserParams.parseResult(resultCode, data)
    );
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
        boolean granted = hasLocation();
        // retain=false: the page asks again next launch, so a later "deny" in
        // Android settings is not overruled by a remembered grant.
        callback.invoke(origin, granted, false);
        // A grant with the system switch off still yields no fix; show that
        // switch now, while the user is looking at the app that needs it.
        if (granted && !isSystemLocationOn()) openLocationSettings();
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

  /**
   * Whether the SYSTEM location switch is on, not just this app's permission.
   *
   * <p>These are two different things and the page can only see the second: with
   * the permission granted and the phone's location switch off, the WebView
   * answers "unavailable" after a timeout and the map's locate button looks
   * broken until the user turns location on from the quick settings. Asking
   * here is what lets the shell say so instead.
   */
  private boolean isSystemLocationOn() {
    LocationManager manager =
      (LocationManager) getSystemService(Context.LOCATION_SERVICE);
    if (manager == null) return hasLocation();
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        return manager.isLocationEnabled();
      }
      return manager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
        manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    } catch (RuntimeException error) {
      Log.w(TAG, "Location state unavailable", error);
      return false;
    }
  }

  /**
   * Send the user to the one switch this app cannot flip. An app may not turn
   * location on by itself; the system screen is the only route, and it is the
   * route every map app takes.
   */
  private void openLocationSettings() {
    try {
      startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
    } catch (ActivityNotFoundException error) {
      Log.w(TAG, "No location settings screen", error);
    }
    Toast.makeText(
      this,
      "Turn on location to let the map follow you.",
      Toast.LENGTH_LONG
    ).show();
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
     * Re-serves a request the hosted server could not answer, from the shell's
     * own client.
     *
     * <p>A hosted copy of this project is the primary data source, but it cannot
     * always reach an upstream: CelesTrak answers a rebroadcast from a
     * datacentre address with a connect timeout, which emptied the satellites
     * layer on a phone whose own network reads the same feed fine. When the
     * server answers 5xx for a route {@link LiveApi} already serves, the shell's
     * copy is a better answer than an outage.
     *
     * <p>Two more answers deserve the same treatment, because they say something
     * about the server's address rather than about the request. A 429 means the
     * server — or the shared address it egresses from, which it does not own — is
     * being rate limited: adsb.lol answers datacentre and shared addresses with
     * 429 while the phone's own address reads the same feed, so the military and
     * direct ADS-B layers went empty on a phone whose traffic was fine. And a
     * refusal of {@code /api/upstream} is a decision about the server's own
     * deliberately narrow read-through list, not about this build: the shell
     * serves that route itself, over its own fixed host list, and did so before
     * any data server existed. Everything else in the 4xx range is a decision
     * (a bad request, a foreign Host, a missing key), so it is passed through.
     *
     * @return the in-app response, or {@code null} to keep the server's answer.
     */
    private WebResourceResponse rescueLocally(
      WebResourceRequest request,
      String path,
      WebResourceResponse forwarded
    ) {
      if (forwarded == null) return null;
      int status = forwarded.getStatusCode();
      boolean serverRateLimited = status == 429;
      boolean upstreamRefused = status >= 400 && "/api/upstream".equals(path);
      if (status < 500 && !serverRateLimited && !upstreamRefused) return null;
      String method = request.getMethod() == null ? "GET" : request.getMethod().toUpperCase(Locale.ROOT);
      if (!"GET".equals(method) && !"HEAD".equals(method)) return null;
      if (!LiveApi.handles(path)) return null;
      WebResourceResponse local = LiveApi.serve(request);
      if (local == null || local.getStatusCode() >= 500) return null;
      Log.i(
        TAG,
        "Data server answered " + status + " for " + path +
          "; served it in-app instead"
      );
      return local;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
      if (request == null || request.getUrl() == null) return false;
      // Everything the console loads is same-origin or a normal https fetch;
      // only a genuinely external link is handed to the system browser.
      Uri target = request.getUrl();
      if (ASSET_HOST.equals(target.getHost())) return false;
      openExternally(target);
      return true;
    }
  }

  /** A popup target: same-origin stays in the console, the rest is external. */
  private void routeWindow(Uri target) {
    if (ASSET_HOST.equals(target.getHost())) {
      if (webView != null) webView.loadUrl(target.toString());
      return;
    }
    openExternally(target);
  }

  /**
   * Hands an external URL to whatever app owns it (browser, Play Store, mail).
   *
   * <p>Claiming the navigation in {@link AssetClient#shouldOverrideUrlLoading}
   * without starting the target app is what made every "get a key" link look
   * dead: the shell answered "handled" and then did nothing.
   */
  private void openExternally(Uri target) {
    String scheme = target.getScheme() == null ? "" : target.getScheme().toLowerCase(Locale.ROOT);
    if (!"http".equals(scheme) && !"https".equals(scheme) &&
      !"mailto".equals(scheme) && !"tel".equals(scheme)) {
      Log.w(TAG, "Refusing to open " + target);
      return;
    }
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, target));
    } catch (ActivityNotFoundException | SecurityException noApp) {
      Log.w(TAG, "No app can open " + target);
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
     * The system file picker behind {@code <input type="file">}.
     *
     * <p>The intent comes from the page's own {@code accept} list, then the
     * MIME types are widened: a WiGLE export is reported as text/csv by one
     * file manager, application/vnd.ms-excel by another and
     * application/octet-stream by a third, and a picker that greys out the
     * operator's own file is worse than no filter at all.
     */
    @Override
    public boolean onShowFileChooser(
      WebView view,
      ValueCallback<Uri[]> callback,
      FileChooserParams params
    ) {
      if (pendingFileChooser != null) {
        pendingFileChooser.onReceiveValue(null);
        pendingFileChooser = null;
      }
      pendingFileChooser = callback;
      Intent intent = params != null ? params.createIntent() : null;
      if (intent == null) {
        intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.setType("*/*");
      }
      intent.addCategory(Intent.CATEGORY_OPENABLE);
      intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
        "text/csv",
        "text/comma-separated-values",
        "text/plain",
        "application/csv",
        "application/vnd.ms-excel",
        "application/octet-stream",
      });
      try {
        startActivityForResult(intent, REQUEST_FILE_CHOOSER);
      } catch (ActivityNotFoundException error) {
        Log.w(TAG, "No file picker available", error);
        pendingFileChooser = null;
        callback.onReceiveValue(null);
        return false;
      }
      return true;
    }

    /**
     * The map's locate button. A fix needs the Android permission, not just the
     * page's: without this the WebView answers "denied" on the first press and
     * the console can only report that the position is unavailable.
     */
    @Override
    public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
      if (hasLocation()) {
        if (!isSystemLocationOn()) {
          // Answering "granted" here would hand the page a provider that never
          // produces a fix, and the locate button would just time out.
          callback.invoke(origin, false, false);
          openLocationSettings();
          return;
        }
        callback.invoke(origin, true, false);
        return;
      }
      pendingLocationCallback = callback;
      pendingLocationOrigin = origin;
      ensureLocation();
    }

    /**
     * A target="_blank" link. Without this the WebView silently drops the
     * popup, which is why the provider links did nothing when tapped.
     */
    @Override
    public boolean onCreateWindow(
      WebView view,
      boolean isDialog,
      boolean isUserGesture,
      Message resultMsg
    ) {
      if (resultMsg == null || !(resultMsg.obj instanceof WebView.WebViewTransport)) {
        return false;
      }
      // The URL of a popup only reaches a client, so resolve it in a throwaway
      // WebView and destroy that as soon as the destination is known.
      final WebView probe = new WebView(MainActivity.this);
      probe.setWebViewClient(
        new WebViewClient() {
          @Override
          public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) {
            if (request == null || request.getUrl() == null) return true;
            routeWindow(request.getUrl());
            probe.destroy();
            return true;
          }

          @Override
          public boolean shouldOverrideUrlLoading(WebView ignored, String url) {
            if (url != null) routeWindow(Uri.parse(url));
            probe.destroy();
            return true;
          }
        }
      );
      ((WebView.WebViewTransport) resultMsg.obj).setWebView(probe);
      resultMsg.sendToTarget();
      return true;
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
