'use strict';

const fs = require('fs');
const path = require('path');
const { app, globalShortcut, Menu } = require('electron');
const { loadConfig } = require('./config');
const { createViewerWindow } = require('./viewerWindow');
const { RelayClient } = require('./relayClient');
const { createRelayServer } = require('./relayServer');
const { registerGmHotkey, revealMissionFolder } = require('./gmHotkey');

const config = loadConfig();
const isGmMode = process.argv.includes('--gm');
const PHOTOS_DIR = path.join(__dirname, '..', '..', 'photos');

function attachDevScreenshotHook(viewer) {
  viewer.window.webContents.on('console-message', (_e, level, message) => {
    console.log(`[renderer console] ${message}`);
  });
  viewer.window.webContents.on('did-finish-load', () => {
    console.log('[main] renderer did-finish-load');
  });
}

function takeDevScreenshotAndQuit(viewer) {
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

app.whenReady().then(() => {
  // Electron's default menu binds Ctrl+Shift+I to "Toggle DevTools" — with a
  // window focused, that accelerator can consume the keypress before our
  // globalShortcut listener ever sees it. This app has no need for a menu
  // bar anyway (kiosk-style capture window).
  Menu.setApplicationMenu(null);

  // Distinct default starting spot per role, purely so two instances launched
  // on the same machine (e.g. this local demo) don't land exactly on top of
  // each other before you've dragged either one. Irrelevant once pilots are
  // on separate physical machines.
  const initialPosition = isGmMode ? { x: 80, y: 80 } : { x: 460, y: 200 };
  const viewer = createViewerWindow({ title: config.windowTitle, hotkeys: config.hotkeys, initialPosition });

  if (process.env.INTEL_BROADCAST_SCREENSHOT_PATH) attachDevScreenshotHook(viewer);

  if (isGmMode) {
    const relayServer = createRelayServer({
      port: config.gm.relayPort,
      token: config.token,
      onLog: (msg) => console.log(`[relay] ${msg}`),
    });

    // The GM's own window is always "connected" — it's the server, not a client.
    viewer.setConnectionState({ connected: true });

    const gmHotkeyOpts = {
      hotkey: config.hotkeys.reveal,
      photosDir: PHOTOS_DIR,
      missionName: config.missionName,
      viewer,
      relayServer,
      onLog: (msg) => console.log(`[gmHotkey] ${msg}`),
    };
    registerGmHotkey(gmHotkeyOpts);

    // Dev/test-only: lets a test harness trigger the same reveal action a real
    // hotkey press would, without simulating an OS-level keypress. Never
    // started unless this env var is explicitly set (never in normal use).
    if (process.env.INTEL_BROADCAST_TEST_TRIGGER_PORT) {
      require('http')
        .createServer((req, res) => {
          revealMissionFolder(gmHotkeyOpts);
          res.end('ok');
        })
        .listen(Number(process.env.INTEL_BROADCAST_TEST_TRIGGER_PORT), '127.0.0.1');
    }

    viewer.window.on('closed', () => relayServer.close());
    return;
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
    if (process.env.INTEL_BROADCAST_SCREENSHOT_PATH) takeDevScreenshotAndQuit(viewer);
    // Dev-only test hook: writes batch metadata to a file so a test harness can
    // confirm this viewer actually received a broadcast, without needing pixels.
    if (process.env.INTEL_BROADCAST_RECEIVED_MARKER_PATH) {
      fs.writeFileSync(
        process.env.INTEL_BROADCAST_RECEIVED_MARKER_PATH,
        JSON.stringify({ batchId: batch.batchId, filenames: batch.items.map((i) => i.filename) }),
      );
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
