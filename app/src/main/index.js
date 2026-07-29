'use strict';

const fs = require('fs');
const path = require('path');
const { app, globalShortcut, Menu } = require('electron');
const { loadConfig } = require('./config');
const { createViewerWindow } = require('./viewerWindow');
const { RelayClient } = require('./relayClient');
const { createRelayServer } = require('./relayServer');
const { registerGmHotkey, revealPhotosFolder } = require('./gmHotkey');
const { createTray } = require('./tray');
const { openSettingsWindow, registerSettingsIpc } = require('./settingsWindow');

const config = loadConfig();
const isGmMode = process.argv.includes('--gm');
const BUNDLED_PHOTOS_DIR = path.join(__dirname, '..', '..', 'photos');

// GM's settings page can point photosFolder at any arbitrary absolute path;
// falls back to the bundled test-fixture convention (photos/<mission-name>/)
// until it's been set once.
const photosFolder = config.photosFolder || path.join(BUNDLED_PHOTOS_DIR, config.missionName);

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
  registerSettingsIpc();

  // A minimal menu bar of our own — NOT Electron's default menu, which binds
  // Ctrl+Shift+I to "Toggle DevTools" and would consume that keypress before
  // our globalShortcut reveal-hotkey listener ever saw it. This gives a
  // normal, discoverable "Settings" entry without that collision.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Intel Broadcast',
        submenu: [
          { label: 'Settings', click: () => openSettingsWindow({ isGmMode, config }) },
          { type: 'separator' },
          { label: 'Quit', role: 'quit' },
        ],
      },
    ]),
  );

  createTray({ onOpenSettings: () => openSettingsWindow({ isGmMode, config }) });

  // Guaranteed way to reach Settings even if the tray icon is hard to spot
  // (easy to happen — it's currently a tiny placeholder, and Windows tucks
  // new tray icons into the hidden-icons overflow by default).
  if (config.hotkeys.settings) {
    globalShortcut.register(config.hotkeys.settings, () => openSettingsWindow({ isGmMode, config }));
  }

  // Dev/test-only: opens the settings window immediately on startup instead of
  // waiting for a tray click, and optionally drives a real save through it —
  // lets a test harness exercise the full preload/contextBridge/ipcMain wiring
  // without needing to click a real tray icon or dialog. Never triggered
  // unless these env vars are explicitly set.
  if (process.env.INTEL_BROADCAST_OPEN_SETTINGS) {
    const settingsWin = openSettingsWindow({ isGmMode, config });
    settingsWin.webContents.on('console-message', (_e, level, message) => {
      console.log(`[settings renderer console] ${message}`);
    });
    settingsWin.webContents.on('did-finish-load', () => {
      console.log('[main] settings did-finish-load');
      if (process.env.INTEL_BROADCAST_SETTINGS_AUTOSAVE_JSON) {
        setTimeout(() => {
          settingsWin.webContents.executeJavaScript(
            `window.settingsAPI.save(${process.env.INTEL_BROADCAST_SETTINGS_AUTOSAVE_JSON})`,
          );
        }, 300);
      }
      // Simulates the Record-button UX (click -> synthetic keydown -> value
      // captured; click -> Escape -> value unchanged) and reports PASS/FAIL
      // via console, which the console-message listener above already pipes
      // to this process's stdout for a test harness to grep.
      if (process.env.INTEL_BROADCAST_HOTKEY_RECORD_TEST) {
        setTimeout(() => {
          settingsWin.webContents.executeJavaScript(`
            (function() {
              try {
                const revealBtn = document.querySelector('.record-btn[data-key="reveal"]');
                revealBtn.click();
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', ctrlKey: true, shiftKey: true, bubbles: true }));
                if (hotkeyValues.reveal !== 'Ctrl+Shift+U') throw new Error('expected Ctrl+Shift+U, got ' + hotkeyValues.reveal);
                if (revealBtn.textContent !== 'Record') throw new Error('button should reset after capture, got ' + revealBtn.textContent);

                const nextBtn = document.querySelector('.record-btn[data-key="next"]');
                const beforeNext = hotkeyValues.next;
                nextBtn.click();
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                if (hotkeyValues.next !== beforeNext) throw new Error('Escape changed the value: ' + beforeNext + ' -> ' + hotkeyValues.next);
                if (nextBtn.textContent !== 'Record') throw new Error('button should reset after Escape, got ' + nextBtn.textContent);

                console.log('RECORD_TEST_PASS');
              } catch (err) {
                console.log('RECORD_TEST_FAIL: ' + err.message);
              }
            })();
          `);
        }, 300);
      }
    });
  }

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
      photosFolder,
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
          revealPhotosFolder(gmHotkeyOpts);
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
