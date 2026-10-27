'use strict';

// Windows/macOS/Linux shell for God's Eye View, built from this repository.
//
// It starts the app's own local server from the payload that ships beside the
// executable and shows it in a window, so an installed copy behaves like the
// terminal path: same routes, same provider panel, same keys. Everything the
// window loads comes from 127.0.0.1 — the shell itself never reaches the
// network.

const { app, BrowserWindow, Menu, dialog } = require('electron');
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

function createWindow(error) {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#05080f',
    title: "God's Eye View",
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
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
    mainWindow.loadURL(APP_URL).catch(() => {});
    mainWindow.webContents.on('did-fail-load', () => {
      log(`loading ${APP_URL} failed — retrying in 3s`);
      setTimeout(
        () => mainWindow && mainWindow.loadURL(APP_URL).catch(() => {}),
        3000,
      );
    });
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
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
