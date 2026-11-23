package com.godseye.view;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * Downloads the published APK and hands it to the platform installer.
 *
 * <p>The console's UPDATE panel used to send the operator to a browser download.
 * That leaves the file in a notification and asks them to find it again; this
 * class fetches the same asset inside the app and opens the system's own
 * confirmation for it. Nothing installs silently: {@link PackageInstaller}
 * commits a session whose status comes back as
 * {@link PackageInstaller#STATUS_PENDING_USER_ACTION}, and the shell starts the
 * intent that arrives with it.
 *
 * <p>Only the project's own release URL is accepted, so a compromised page can
 * not talk the shell into installing an arbitrary APK. The download is checked
 * before it is offered: same package, a strictly higher version code, and the
 * same signing certificate the installed copy carries. The platform enforces
 * the signature anyway; checking here turns its generic failure into a sentence
 * the panel can show. A version code that does not advance is not an update.
 */
final class ApkUpdater {

  private static final String TAG = "GodsEyeView";
  private static final String ACTION_STATUS = "com.godseye.view.UPDATE_STATUS";
  private static final String APK_NAME = "gods-eye-view-update.apk";

  /** What this updater needs from the shell that owns it. */
  interface Host {
    /** One progress line for the page, called from any thread. */
    void emitUpdate(String status, int progress, String message);

    /** Where the operator grants "install unknown apps" for this app. */
    void openUnknownSourceSettings();
  }

  private final Activity activity;
  private final Host host;
  private boolean registered = false;

  private final BroadcastReceiver statusReceiver = new BroadcastReceiver() {
    @Override
    public void onReceive(Context context, Intent intent) {
      if (!ACTION_STATUS.equals(intent.getAction())) return;
      int status = intent.getIntExtra(
        PackageInstaller.EXTRA_STATUS,
        PackageInstaller.STATUS_FAILURE
      );
      String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
      if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
        Intent confirm = userAction(intent);
        host.emitUpdate("confirm", 100, "");
        if (confirm != null) {
          try {
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(confirm);
          } catch (RuntimeException error) {
            Log.w(TAG, "The installer prompt could not start", error);
            host.emitUpdate("failed", 0, "the installer prompt could not start");
          }
        }
        return;
      }
      // The session has already copied the APK out of the cache by now.
      deleteDownload();
      if (status == PackageInstaller.STATUS_SUCCESS) {
        host.emitUpdate("installed", 100, "");
        return;
      }
      host.emitUpdate(
        "failed",
        0,
        message == null || message.isEmpty()
          ? "installer status " + status
          : message
      );
    }
  };

  ApkUpdater(Activity activity, Host host) {
    this.activity = activity;
    this.host = host;
  }

  /** Listen for the installer's answer; the shell unregisters on destroy. */
  void register() {
    if (registered) return;
    IntentFilter filter = new IntentFilter(ACTION_STATUS);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      activity.registerReceiver(
        statusReceiver,
        filter,
        Context.RECEIVER_NOT_EXPORTED
      );
    } else {
      activity.registerReceiver(statusReceiver, filter);
    }
    registered = true;
  }

  void close() {
    if (!registered) return;
    try {
      activity.unregisterReceiver(statusReceiver);
    } catch (IllegalArgumentException alreadyGone) {
      // A destroyed activity has no receiver left to remove.
    }
    registered = false;
  }

  /**
   * Begin an update from one URL. Returns false when nothing was started —
   * the grant prompt was opened, or the URL is not a release this shell can
   * take — so the page knows to wait rather than to announce progress.
   */
  boolean start(String rawUrl) {
    String url = rawUrl == null ? "" : rawUrl.trim();
    if (!isReleaseUrl(url)) {
      Log.w(TAG, "Refusing update download from " + url);
      host.emitUpdate("failed", 0, "not a published release URL");
      return false;
    }
    if (!canInstallPackages()) {
      host.openUnknownSourceSettings();
      host.emitUpdate("permission", 0, "");
      return false;
    }
    Thread worker = new Thread(() -> downloadAndInstall(url), "gev-update");
    worker.start();
    return true;
  }

  /**
   * The asset URL the UPDATE panel offers must be this project's own https
   * release: GitHub serves the APK from github.com and redirects the download
   * to objects.githubusercontent.com, so both origins are legitimate.
   */
  static boolean isReleaseUrl(String url) {
    Uri uri = Uri.parse(url);
    if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
    String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
    String path = uri.getPath() == null ? "" : uri.getPath();
    if ("github.com".equals(host)) {
      return path.startsWith("/Neo690/gods-eye-view/releases/");
    }
    return "objects.githubusercontent.com".equals(host);
  }

  /** Android 8 asks per app; older releases only ask at install time. */
  private boolean canInstallPackages() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
    return activity.getPackageManager().canRequestPackageInstalls();
  }

  private void downloadAndInstall(String url) {
    File apk = new File(activity.getCacheDir(), APK_NAME);
    HttpURLConnection connection = null;
    try {
      connection = (HttpURLConnection) new URL(url).openConnection();
      connection.setInstanceFollowRedirects(true);
      connection.setConnectTimeout(15_000);
      connection.setReadTimeout(30_000);
      connection.setRequestProperty("Accept", "application/octet-stream");
      int code = connection.getResponseCode();
      if (code != HttpURLConnection.HTTP_OK) {
        fail("the download answered HTTP " + code);
        return;
      }
      long total = connection.getContentLengthLong();
      long copied = 0;
      long lastEmit = 0;
      host.emitUpdate("downloading", 0, "");
      try (
        InputStream input = connection.getInputStream();
        OutputStream output = new FileOutputStream(apk, false)
      ) {
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = input.read(buffer)) > 0) {
          output.write(buffer, 0, read);
          copied += read;
          long now = System.currentTimeMillis();
          if (now - lastEmit >= 250) {
            lastEmit = now;
            int percent = total > 0
              ? (int) Math.min(100, (copied * 100) / total)
              : 0;
            host.emitUpdate("downloading", percent, "");
          }
        }
      }
      if (copied == 0) {
        fail("the download was empty");
        return;
      }
      if (!verify(apk)) return;
      install(apk);
    } catch (IOException error) {
      Log.w(TAG, "Update download failed", error);
      fail("the download failed: " + error.getMessage());
    } catch (SecurityException error) {
      Log.w(TAG, "Update download was refused", error);
      fail("the download was refused");
    } finally {
      if (connection != null) connection.disconnect();
    }
  }

  /**
   * Refuse an APK that is not this app, is not newer, or comes from another
   * signing key. The last one would fail at install anyway, but the platform's
   * message ("app not installed") names none of the three.
   */
  private boolean verify(File apk) {
    try {
      PackageManager manager = activity.getPackageManager();
      int archiveFlags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        ? PackageManager.GET_SIGNING_CERTIFICATES
        : PackageManager.GET_SIGNATURES;
      PackageInfo archive = manager.getPackageArchiveInfo(apk.getPath(), archiveFlags);
      if (archive == null) {
        fail("the download is not an APK");
        return false;
      }
      if (!activity.getPackageName().equals(archive.packageName)) {
        fail("the download is not this app");
        return false;
      }
      long installed = versionCode(manager.getPackageInfo(
        activity.getPackageName(),
        0
      ));
      if (versionCode(archive) <= installed) {
        fail("the download is not newer than the installed app");
        return false;
      }
      if (!sameSigner(manager, archive)) {
        fail("the download is signed by a different key");
        return false;
      }
      return true;
    } catch (PackageManager.NameNotFoundException | RuntimeException error) {
      Log.w(TAG, "The downloaded APK could not be checked", error);
      fail("the download could not be checked");
      return false;
    }
  }

  @SuppressWarnings("deprecation")
  private static long versionCode(PackageInfo info) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      return info.getLongVersionCode();
    }
    return info.versionCode;
  }

  /**
   * Compare the archive's signing certificate with the installed one.
   *
   * <p>An unreadable certificate is not a mismatch: a v2-only APK read through
   * the deprecated {@code GET_SIGNATURES} path can report none on the oldest
   * supported releases, and the platform still refuses a different key at
   * install time. Only two readable, unequal certificates earn the early
   * refusal.
   */
  @SuppressWarnings("deprecation")
  private boolean sameSigner(PackageManager manager, PackageInfo archive)
    throws PackageManager.NameNotFoundException {
    Signature[] mine;
    Signature[] theirs;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      PackageInfo installed = manager.getPackageInfo(
        activity.getPackageName(),
        PackageManager.GET_SIGNING_CERTIFICATES
      );
      mine = installed.signingInfo == null
        ? null
        : installed.signingInfo.getApkContentsSigners();
      theirs = archive.signingInfo == null
        ? null
        : archive.signingInfo.getApkContentsSigners();
    } else {
      PackageInfo installed = manager.getPackageInfo(
        activity.getPackageName(),
        PackageManager.GET_SIGNATURES
      );
      mine = installed.signatures;
      theirs = archive.signatures;
    }
    if (mine == null || theirs == null || mine.length == 0 || theirs.length == 0) {
      return true;
    }
    return digest(mine[0]).equals(digest(theirs[0]));
  }

  private static String digest(Signature signature) {
    try {
      byte[] bytes = MessageDigest.getInstance("SHA-256").digest(
        signature.toByteArray()
      );
      StringBuilder out = new StringBuilder(bytes.length * 2);
      for (byte value : bytes) {
        // Mask the sign extension: a bare byte formats -1 as ffffffff.
        out.append(String.format(Locale.ROOT, "%02x", value & 0xff));
      }
      return out.toString();
    } catch (Exception error) {
      return "";
    }
  }

  /**
   * Open a full-install session, stream the APK into it, and commit with a
   * broadcast the receiver above turns into a status line for the page.
   */
  private void install(File apk) throws IOException {
    PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
    PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
      PackageInstaller.SessionParams.MODE_FULL_INSTALL
    );
    params.setSize(apk.length());
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      params.setInstallReason(PackageManager.INSTALL_REASON_USER);
    }
    int sessionId = installer.createSession(params);
    try (PackageInstaller.Session session = installer.openSession(sessionId)) {
      try (
        InputStream input = new FileInputStream(apk);
        OutputStream output = session.openWrite(APK_NAME, 0, apk.length())
      ) {
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = input.read(buffer)) > 0) output.write(buffer, 0, read);
        output.flush();
        session.fsync(output);
      }
      session.commit(pendingIntent().getIntentSender());
    }
  }

  private PendingIntent pendingIntent() {
    Intent status = new Intent(ACTION_STATUS).setPackage(activity.getPackageName());
    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      // The platform fills in EXTRA_INTENT for the confirmation screen, so the
      // intent must stay mutable.
      flags |= PendingIntent.FLAG_MUTABLE;
    }
    return PendingIntent.getBroadcast(activity, 7, status, flags);
  }

  @SuppressWarnings("deprecation")
  private static Intent userAction(Intent intent) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
    }
    return intent.getParcelableExtra(Intent.EXTRA_INTENT);
  }

  private void fail(String message) {
    deleteDownload();
    host.emitUpdate("failed", 0, message);
  }

  private void deleteDownload() {
    try {
      File apk = new File(activity.getCacheDir(), APK_NAME);
      if (apk.exists()) apk.delete();
    } catch (SecurityException ignored) {
      // A cache we cannot clean is the platform's problem, not the update's.
    }
  }
}
