'use strict';

// The preload is the only code that runs with both the page and Electron in
// scope. It exposes one narrow object, and only on Windows: the console's
// UPDATE panel asks the main process to download and apply the published
// installer, and receives progress through `onUpdateEvent`.
//
// Nothing else crosses the bridge — no filesystem, no shell, no ipcRenderer —
// so a compromised page still cannot do more than ask for the update the panel
// already offers.

const { contextBridge, ipcRenderer } = require('electron');

if (process.platform === 'win32') {
  contextBridge.exposeInMainWorld('gevDesktop', {
    /**
     * Start the in-app update. The main process checks the feed, downloads the
     * installer and restarts into it; progress arrives through onUpdateEvent.
     */
    installUpdate: () => {
      ipcRenderer.send('gev:update:install');
      return true;
    },

    /** Subscribe to installer events; returns an unsubscribe function. */
    onUpdateEvent: (listener) => {
      const handler = (_event, payload) => {
        try {
          listener(payload);
        } catch {
          // A broken listener must not take the main process's channel down.
        }
      };
      ipcRenderer.on('gev:update', handler);
      return () => ipcRenderer.removeListener('gev:update', handler);
    },
  });
}
