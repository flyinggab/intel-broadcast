'use strict';

const fs = require('fs');
const { app, globalShortcut } = require('electron');
const { loadConfig } = require('./config');
const { createViewerWindow } = require('./viewerWindow');
const { RelayClient } = require('./relayClient');

const config = loadConfig();

app.whenReady().then(() => {
  const viewer = createViewerWindow({ title: config.windowTitle, hotkeys: config.hotkeys });

  if (process.env.INTEL_BROADCAST_SCREENSHOT_PATH) {
    viewer.window.webContents.on('console-message', (_e, level, message) => {
      console.log(`[renderer console] ${message}`);
    });
    viewer.window.webContents.on('did-finish-load', () => {
      console.log('[main] renderer did-finish-load');
    });
  }

  const relayClient = new RelayClient({
    url: config.relayUrl,
    token: config.token,
    role: 'viewer',
    callsign: config.callsign,
  });

  relayClient.on('connected', () => viewer.setConnectionState({ connected: true }));
  relayClient.on('disconnected', () => viewer.setConnectionState({ connected: false }));
  relayClient.on('reveal-batch', (batch) => {
    viewer.showBatch(batch);
    // Dev-only visual verification hook: INTEL_BROADCAST_SCREENSHOT_PATH captures
    // the rendered window to a PNG after a batch lands, then quits. Not used in
    // normal operation.
    if (process.env.INTEL_BROADCAST_SCREENSHOT_PATH) {
      setTimeout(async () => {
        if (viewer.window.isDestroyed()) return;
        try {
          const image = await viewer.window.webContents.capturePage();
          if (viewer.window.isDestroyed()) return; // window closed while capture was in flight
          fs.writeFileSync(process.env.INTEL_BROADCAST_SCREENSHOT_PATH, image.toPNG());
        } catch (err) {
          console.error(`[screenshot hook] capture failed: ${err.message}`);
        } finally {
          app.quit();
        }
      }, 500);
    }
  });

  relayClient.connect();

  viewer.window.on('closed', () => relayClient.close());
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
