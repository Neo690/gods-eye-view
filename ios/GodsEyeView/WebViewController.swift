import CoreLocation
import UIKit
import WebKit

/// The console, in a WebView, on the loopback origin `LocalServer` provides.
///
/// Everything the Android shell does through `WebChromeClient` and
/// `WebViewClient` has one counterpart here:
///
/// - microphone: `requestMediaCapturePermissionFor` (a secure origin plus this
///   grant is what `getUserMedia` needs);
/// - location: the plist purpose string plus Core Location authorization, which
///   WebKit asks for on the page's behalf;
/// - `target="_blank"`: WebKit hands it to `createWebViewWith`, which opens the
///   browser instead of dropping the provider link;
/// - console output: mirrored to the device log under `GodsEyeView`.
final class WebViewController: UIViewController {
  private let startURL: URL
  private var webView: WKWebView!
  private let locationManager = CLLocationManager()

  init(startURL: URL) {
    self.startURL = startURL
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not used")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor(red: 5 / 255, green: 8 / 255, blue: 10 / 255, alpha: 1)

    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    configuration.allowsInlineMediaPlayback = true
    // The dock's voice controls start audio without a tap of their own; the
    // page's mic button is the user gesture that matters.
    configuration.mediaTypesRequiringUserActionForPlayback = []

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.translatesAutoresizingMaskIntoConstraints = false
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.scrollView.bounces = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.allowsBackForwardNavigationGestures = false
    if #available(iOS 16.4, *) {
      webView.isInspectable = true
    }

    view.addSubview(webView)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      webView.topAnchor.constraint(equalTo: view.topAnchor),
      webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    self.webView = webView

    // Asking once at boot means the system prompt is answered while the map is
    // already on screen, instead of interrupting the first "locate" press.
    locationManager.requestWhenInUseAuthorization()

    webView.load(URLRequest(url: startURL))
  }

  /// The listener can be torn down while the app is suspended; the page stays
  /// loaded, so the origin has to answer again before the next request.
  func reloadFromServer() {
    guard webView.url == nil else {
      webView.reload()
      return
    }
    webView.load(URLRequest(url: startURL))
  }
}

extension WebViewController: WKNavigationDelegate {
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.allow)
      return
    }
    if url.host == "127.0.0.1" || url.host == "localhost" {
      decisionHandler(.allow)
      return
    }
    // A genuine external link (a provider's "get a key" page, a credits page)
    // belongs in the browser. Inside the console it would replace the map.
    if navigationAction.navigationType == .linkActivated {
      UIApplication.shared.open(url)
      decisionHandler(.cancel)
      return
    }
    decisionHandler(.allow)
  }

  func webView(
    _ webView: WKWebView,
    didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    NSLog("[GodsEyeView] load failed: \(error.localizedDescription)")
  }
}

extension WebViewController: WKUIDelegate {
  /// Grants the page's microphone request. The permission the operator answers
  /// is iOS's own (the plist string), not a second one invented here.
  @available(iOS 15.0, *)
  func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    switch type {
    case .microphone, .cameraAndMicrophone:
      decisionHandler(.grant)
    default:
      decisionHandler(.prompt)
    }
  }

  /// `target="_blank"`, which is how every provider key link is written.
  /// Returning nil tells WebKit there is no second window; the URL is opened
  /// by the system browser instead.
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url {
      UIApplication.shared.open(url)
    }
    return nil
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping () -> Void
  ) {
    let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
    present(alert, animated: true)
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (Bool) -> Void
  ) {
    let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
    alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
    present(alert, animated: true)
  }
}
