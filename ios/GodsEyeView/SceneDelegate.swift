import UIKit

/// Builds the window, starts the loopback origin and hands the page to
/// `WebViewController`.
///
/// The background/foreground handling mirrors the Android shell's
/// `onPause`/`onResume`: the listener is cancelled when the scene leaves the
/// foreground and bound again before the page can make its next request.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var environment: AppEnvironment?
  private var controller: WebViewController?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: windowScene)
    window.backgroundColor = UIColor(red: 5 / 255, green: 8 / 255, blue: 10 / 255, alpha: 1)
    self.window = window

    let environment = AppEnvironment()
    self.environment = environment

    do {
      let url = try environment.start()
      let controller = WebViewController(startURL: url)
      self.controller = controller
      window.rootViewController = controller
    } catch {
      window.rootViewController = StartupFailureViewController(message: Self.describe(error))
    }

    window.makeKeyAndVisible()

    NotificationCenter.default.addObserver(
      self,
      selector: #selector(didEnterBackground),
      name: UIApplication.didEnterBackgroundNotification,
      object: nil
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(willEnterForeground),
      name: UIApplication.willEnterForegroundNotification,
      object: nil
    )
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    environment?.stop()
    NotificationCenter.default.removeObserver(self)
  }

  /// iOS may take the socket back while the process is suspended, and while the
  /// WebView is paused nothing needs it.
  @objc private func didEnterBackground() {
    environment?.stop()
  }

  /// Bind again before the page is allowed to run. If the port is gone — a
  /// second copy of the app, a stale listener — the failure is shown rather than
  /// leaving the console on screen with dead requests.
  @objc private func willEnterForeground() {
    guard let environment else { return }
    if environment.ensureServing() { return }
    environment.stop()
    let alert = UIAlertController(
      title: "The console stopped serving",
      message: """
      Its local port is held by something else, so live data cannot load.

      Close any other copy of the app and reopen it.
      """,
      preferredStyle: .alert
    )
    alert.addAction(UIAlertAction(title: "Retry", style: .default) { [weak self] _ in
      self?.retryStart()
    })
    controller?.present(alert, animated: true)
  }

  private func retryStart() {
    guard let environment, let controller else { return }
    do {
      _ = try environment.start()
      controller.reloadFromServer()
    } catch {
      NSLog("[GodsEyeView] retry failed: \(error.localizedDescription)")
    }
  }

  private static func describe(_ error: Error) -> String {
    if let localized = error as? LocalizedError, let description = localized.errorDescription {
      return description
    }
    return error.localizedDescription
  }
}

/// Shown instead of the console when the bundle could not be served at all: a
/// blank black screen would read as a crash.
final class StartupFailureViewController: UIViewController {
  private let message: String

  init(message: String) {
    self.message = message
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not used")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = UIColor(red: 5 / 255, green: 8 / 255, blue: 10 / 255, alpha: 1)

    let title = UILabel()
    title.text = "God's Eye View could not start"
    title.textColor = .white
    title.font = .preferredFont(forTextStyle: .headline)
    title.numberOfLines = 0

    let body = UILabel()
    body.text = message
    body.textColor = UIColor(white: 0.75, alpha: 1)
    body.font = .preferredFont(forTextStyle: .body)
    body.numberOfLines = 0

    let stack = UIStackView(arrangedSubviews: [title, body])
    stack.axis = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)

    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
  }
}
