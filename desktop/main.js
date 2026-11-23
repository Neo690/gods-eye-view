'use strict';

// Windows/macOS/Linux shell for God's Eye View, built from this repository.
//
// It starts the app's own local server from the payload that ships beside the
// executable and shows it in a window, so an installed copy behaves like the
// terminal path: same routes, same provider panel, same keys. Everything the
// window loads comes from 127.0.0.1 — the shell itself never reaches the
// network.

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_PORT,
  ensureServer,
  payloadRoot,
  probe,
  stopServer,
} = require('./server');

const PORT =
  Number.parseInt(process.env.GEV_DESKTOP_PORT ?? '', 10) || DEFAULT_PORT;
const APP_URL = `http://127.0.0.1:${PORT}/`;
// A released installer is smoke-tested with `--verify`: start the server, ask
// the running app one question, exit without opening a window.
const VERIFY = process.argv.includes('--verify');

const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'main.log');

// The window frame already names the app in its title bar, and the scene draws
// the same name as its own wordmark a few pixels lower: two titles stacked in
// the top-left corner. The frame stays — it is what moves and closes the
// window — and the page's copy is hidden, the way the phone shell already
// hides its wordmark. The browser build, which has no frame, keeps it.
const DESKTOP_CHROME_CSS = '#title-bar { display: none !important; }';

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // A read-only profile must not stop the app from showing the globe.
  }
}

let mainWindow = null;
let serverChild = null;
/** electron-updater's instance once initUpdates has wired it; null off Windows. */
let autoUpdater = null;

function createWindow(error) {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#05080f',
    title: "God's Eye View",
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // Windows already draws "God's Eye View" in the title bar; the app menu's
    // top-level label would repeat it directly underneath. Hide the menu bar
    // until Alt asks for it, the way a native Windows app does.
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // The only bridge the page gets: a request to install the published
      // update, and the progress the main process sends back.
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (error) {
    // The window still opens: a blank screen with no explanation is the one
    // failure a user cannot act on.
    mainWindow
      .loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(
            `<body style="font:14px/1.5 system-ui;background:#05080f;color:#e8eef7;padding:2rem">
             <h1 style="font-size:1.1rem">The local server did not start</h1>
             <p>${error}</p>
             <p>Details: ${LOG_FILE.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>
           </body>`,
          ),
      )
      .catch(() => {});
  } else {
    // Re-applied on every load (F5 included): insertCSS belongs to one document.
    mainWindow.webContents.on('dom-ready', () => {
      mainWindow.webContents.insertCSS(DESKTOP_CHROME_CSS).catch(() => {});
    });
    mainWindow.loadURL(APP_URL).catch(() => {});
    mainWindow.webContents.on('did-fail-load', () => {
      log(`loading ${APP_URL} failed — retrying in 3s`);
      setTimeout(
        () => mainWindow && mainWindow.loadURL(APP_URL).catch(() => {}),
        3000,
      );
    });
  }

  // The console's own external links (update downloads, provider key pages)
  // belong to the system browser, not to a second Electron window that has no
  // server or keys: any popup target off the local origin opens outside.
  const isAppOrigin = (url) =>
    url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:');
  const openExternally = (url) => {
    if (isAppOrigin(String(url || ''))) return { action: 'allow' };
    shell.openExternal(String(url || '')).catch(() => {});
    return { action: 'deny' };
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => openExternally(url));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppOrigin(url)) return;
    event.preventDefault();
    shell.openExternal(url).catch(() => {});
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

/** One update status line for the page; silent once the window is gone. */
function sendUpdate(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('gev:update', payload);
}

/**
 * Wire the Windows updater to the UPDATE panel.
 *
 * `electron-updater` reads the generic feed configured in
 * electron-builder.yml — the rolling `desktop-latest` release — so the panel's
 * own button downloads the published Setup and restarts into it. The download
 * starts only on that request (autoDownload is off); the installer is applied
 * with quitAndInstall, not on a later quit nobody asked for. A checkout run
 * from source has no update feed, and says so instead of failing silently.
 */
function initUpdates() {
  ipcMain.on('gev:update:install', async () => {
    if (!autoUpdater) {
      sendUpdate({
        status: 'failed',
        progress: 0,
        message: 'updates run in an installed copy, not a checkout',
      });
      return;
    }
    sendUpdate({ status: 'downloading', progress: 0 });
    try {
      const result = await autoUpdater.checkForUpdates();
      const latest = result?.updateInfo?.version;
      if (!latest || latest === app.getVersion()) {
        sendUpdate({
          status: 'failed',
          progress: 0,
          message: 'this build is already the published version',
        });
        return;
      }
      await autoUpdater.downloadUpdate();
    } catch (error) {
      sendUpdate({
        status: 'failed',
        progress: 0,
        message: String(error?.message || error),
      });
    }
  });

  if (process.platform !== 'win32' || !app.isPackaged) {
    autoUpdater = null;
    return;
  }
  try {
    // Required lazily: a source checkout without the shell's dependencies must
    // still open the window, and only the update button is lost.
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    log(`electron-updater is unavailable: ${error && error.message}`);
    autoUpdater = null;
    return;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: log,
    warn: log,
    error: log,
    debug: () => {},
  };
  autoUpdater.on('download-progress', (progress) => {
    sendUpdate({
      status: 'downloading',
      progress: Math.round(Number(progress?.percent) || 0),
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    // The panel paints this line before the process goes away, so the restart
    // reads as the install rather than as a crash.
    sendUpdate({
      status: 'restarting',
      progress: 100,
      message: String(info?.version || ''),
    });
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (error) {
        log(`quitAndInstall failed: ${error && error.message}`);
        sendUpdate({
          status: 'failed',
          progress: 0,
          message: String(error?.message || error),
        });
      }
    }, 1200);
  });
  autoUpdater.on('error', (error) => {
    sendUpdate({
      status: 'failed',
      progress: 0,
      message: String(error?.message || error),
    });
  });
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "God's Eye View",
        submenu: [
          {
            label: 'Reload the globe',
            accelerator: 'F5',
            click: () => mainWindow && mainWindow.reload(),
          },
          {
            label: 'Full screen',
            accelerator: 'F11',
            click: () =>
              mainWindow &&
              mainWindow.setFullScreen(!mainWindow.isFullScreen()),
          },
          {
            label: 'Check for update',
            // The console owns the update UI (the chrome-top update button);
            // the menu item just puts the same dialog on screen.
            click: () =>
              mainWindow &&
              mainWindow.webContents
                .executeJavaScript(
                  "document.getElementById('update-check-btn')?.click()",
                )
                .catch(() => {}),
          },
          {
            label: 'Latest desktop release',
            click: () =>
              openExternally(
                'https://github.com/Neo690/gods-eye-view/releases/desktop-latest',
              ),
          },
          { type: 'separator' },
          { label: 'Quit', click: () => app.quit() },
        ],
      },
    ]),
  );
}

async function start() {
  const root = payloadRoot({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    moduleDir: __dirname,
  });
  log(
    `starting God's Eye View ${app.getVersion()} — payload ${root} — port ${PORT}`,
  );

  const server = await ensureServer({ root, port: PORT, log });
  serverChild = server.child ?? null;

  if (VERIFY) {
    const answer = await probe(PORT, '/api/setup/status');
    if (server.started) stopServer(serverChild);
    let listed = false;
    try {
      listed = Array.isArray(JSON.parse(answer.body || '{}').keys);
    } catch {
      listed = false;
    }
    const ok = answer.status === 200 && listed;
    log(
      `verify: ${ok ? 'ok' : 'failed'} — /api/setup/status -> ${answer.status} ${answer.error ?? ''}`,
    );
    app.exit(ok ? 0 : 1);
    return;
  }

  if (server.error) {
    log(`the server could not start (${server.error})`);
    createWindow(
      server.error === 'payload-incomplete'
        ? 'The application payload is incomplete; reinstall from the installer.'
        : 'No usable Node runtime was found, or the port is blocked.',
    );
    return;
  }

  createWindow();
}

app.whenReady().then(async () => {
  initUpdates();
  buildMenu();
  await start().catch((error) => {
    log(`startup failed: ${error && error.stack ? error.stack : error}`);
    dialog.showErrorBox(
      "God's Eye View",
      String(error && error.message ? error.message : error),
    );
    app.exit(1);
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => stopServer(serverChild));
