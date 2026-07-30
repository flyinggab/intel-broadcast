'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { app, globalShortcut, Menu } = require('electron');
const { loadConfig } = require('./config');
const { createViewerWindow } = require('./viewerWindow');
const { RelayClient } = require('./relayClient');
const { createRelayServer } = require('./relayServer');
const { revealPhotosFolder } = require('./gmHotkey');
const { createTray } = require('./tray');
const { openSettingsWindow, registerSettingsIpc, pushConnectedClients } = require('./settingsWindow');

const BUNDLED_PHOTOS_DIR = path.join(__dirname, '..', '..', 'photos');

// Mutable session state: a settings save re-loads `config` and live-restarts
// just the pieces the changed values affect (hotkey registrations, embedded
// relay server, relay client) via applyNewConfig() — no app relaunch.
let config = loadConfig();
let viewer = null;
let relayServer = null; // present iff GM mode is currently on
let relayClient = null; // present iff GM mode is currently off

// GM mode is a config value the Settings window toggles (a checkbox, saved to
// config.local.json like everything else), not a launch flag — and since a
// save applies live, it can now flip mid-session.
function isGmMode() {
  return config.gmModeEnabled === true;
}

// GM's settings page can point photosFolder at any arbitrary absolute path;
// falls back to the bundled test-fixture convention (photos/<mission-name>/)
// until it's been set once. Resolved at reveal time, so a folder change in
// Settings applies from the very next hotkey press.
function currentPhotosFolder() {
  return config.photosFolder || path.join(BUNDLED_PHOTOS_DIR, config.missionName);
}

function openSettings() {
  return openSettingsWindow({
    isGmMode: isGmMode(),
    config,
    getConnectedClients: () => (relayServer ? relayServer.getConnectedClients() : []),
  });
}

function doReveal() {
  if (!relayServer) {
    console.log('[gmHotkey] reveal ignored — GM mode is off');
    return;
  }
  revealPhotosFolder({
    photosFolder: currentPhotosFolder(),
    viewer,
    relayServer,
    onLog: (msg) => console.log(`[gmHotkey] ${msg}`),
  });
}

function registerHotkey(name, accelerator, handler) {
  if (!accelerator) return;
  const ok = globalShortcut.register(accelerator, handler);
  console.log(`[hotkeys] register ${name} "${accelerator}": ${ok ? 'OK' : 'FAILED (already taken by another app?)'}`);
}

/**
 * (Re-)registers every global shortcut from the current config — called once
 * at startup and again on every settings save. Starting from unregisterAll()
 * is what makes a hotkey change apply live: the old accelerators are released
 * in the same step that claims the new ones.
 */
function registerHotkeys() {
  globalShortcut.unregisterAll();
  registerHotkey('settings', config.hotkeys.settings, openSettings);
  registerHotkey('next', config.hotkeys.next, () => viewer.navigate('next'));
  registerHotkey('prev', config.hotkeys.prev, () => viewer.navigate('prev'));
  if (isGmMode()) registerHotkey('reveal', config.hotkeys.reveal, doReveal);

  // Dev/test-only: reports what got registered to a file. Rewritten on every
  // (re-)registration, so a test can watch a live settings apply swap hotkeys
  // without the process restarting.
  if (process.env.INTEL_BROADCAST_HOTKEY_REGISTER_MARKER_PATH) {
    fs.writeFileSync(
      process.env.INTEL_BROADCAST_HOTKEY_REGISTER_MARKER_PATH,
      JSON.stringify({
        reveal: config.hotkeys.reveal,
        revealRegistered: globalShortcut.isRegistered(config.hotkeys.reveal),
      }),
    );
  }
}

function startGmRole() {
  relayServer = createRelayServer({
    port: config.gm.relayPort,
    token: config.token,
    onLog: (msg) => console.log(`[relay] ${msg}`),
    // Keeps the settings window's "Connected clients" section live while open.
    onClientsChanged: pushConnectedClients,
  });
  // The GM's own window is always "connected" — it's the server, not a client.
  viewer.setConnectionState({ connected: true });
}

/**
 * Tears down the embedded relay (terminating client sockets so the port is
 * released immediately) and calls `done` once it's fully closed — restarting
 * on the same port must wait for that, or it races into EADDRINUSE.
 */
function stopGmRole(done = () => {}) {
  if (!relayServer) {
    done();
    return;
  }
  const server = relayServer;
  relayServer = null;
  server.close(done);
}

function startViewerRole() {
  relayClient = new RelayClient({
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

  // Until the first 'connected' fires this shows the disconnected banner —
  // truthful during a live GM->viewer switch. At first boot the renderer
  // hasn't loaded yet and the message is simply dropped, same as before.
  viewer.setConnectionState({ connected: false });
  relayClient.connect();
}

/**
 * Closes the relay client and drops its listeners first, so the 'disconnected'
 * its closing socket emits asynchronously can't repaint the banner after a new
 * role has already taken over the connection state.
 */
function stopViewerRole() {
  if (!relayClient) return;
  relayClient.removeAllListeners();
  relayClient.close();
  relayClient = null;
}

/**
 * Live-applies a freshly saved config: hotkeys always re-register; the relay
 * server / relay client only restart when a value they depend on actually
 * changed, so an unrelated save (e.g. a hotkey tweak) never drops anyone's
 * connection.
 */
function applyNewConfig(newConfig) {
  const old = config;
  config = newConfig;

  registerHotkeys();

  const wasGm = old.gmModeEnabled === true;
  if (isGmMode() && !wasGm) {
    stopViewerRole();
    startGmRole();
    console.log('[index] GM mode enabled — embedded relay started');
  } else if (!isGmMode() && wasGm) {
    stopGmRole();
    startViewerRole();
    console.log('[index] GM mode disabled — connecting as viewer');
  } else if (isGmMode()) {
    const relayChanged = old.gm.relayPort !== config.gm.relayPort || old.token !== config.token;
    if (relayChanged) {
      stopGmRole(() => {
        startGmRole();
        console.log('[index] relay settings changed — embedded relay restarted');
      });
    }
  } else {
    const clientChanged =
      old.relayUrl !== config.relayUrl || old.token !== config.token || old.callsign !== config.callsign;
    if (clientChanged) {
      stopViewerRole();
      startViewerRole();
      console.log('[index] relay connection settings changed — reconnecting');
    }
  }
}

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
  registerSettingsIpc({ onSaved: () => applyNewConfig(loadConfig()) });

  // A minimal menu bar of our own — NOT Electron's default menu, which binds
  // Ctrl+Shift+I to "Toggle DevTools" and would consume that keypress before
  // our globalShortcut reveal-hotkey listener ever saw it. This gives a
  // normal, discoverable "Settings" entry without that collision.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Intel Broadcast',
        submenu: [
          { label: 'Settings', click: openSettings },
          { type: 'separator' },
          { label: 'Quit', role: 'quit' },
        ],
      },
    ]),
  );

  createTray({ onOpenSettings: openSettings });

  // Dev/test-only: opens the settings window immediately on startup instead of
  // waiting for a tray click, and optionally drives a real save through it —
  // lets a test harness exercise the full preload/contextBridge/ipcMain wiring
  // without needing to click a real tray icon or dialog. Never triggered
  // unless these env vars are explicitly set.
  if (process.env.INTEL_BROADCAST_OPEN_SETTINGS) {
    const settingsWin = openSettings();
    settingsWin.webContents.on('console-message', (_e, level, message) => {
      console.log(`[settings renderer console] ${message}`);
    });
    settingsWin.webContents.on('did-finish-load', () => {
      console.log('[main] settings did-finish-load');
      // Reports the renderer's actual viewport metrics so a test can confirm
      // the uiZoom from scaling.js was really applied by the preload.
      if (process.env.INTEL_BROADCAST_ZOOM_PROBE) {
        settingsWin.webContents.executeJavaScript(
          'console.log(`ZOOM_PROBE innerWidth=${window.innerWidth} dpr=${window.devicePixelRatio}`)',
        );
      }
      // Periodically reports the rendered "Connected clients" list so a test
      // can confirm live client join/leave updates reach the settings DOM.
      if (process.env.INTEL_BROADCAST_CLIENTS_PROBE) {
        const probe = setInterval(() => {
          if (settingsWin.isDestroyed()) {
            clearInterval(probe);
            return;
          }
          settingsWin.webContents
            .executeJavaScript(
              `console.log('CLIENTS_PROBE ' + document.getElementById('connected-clients').textContent.trim().replace(/\\s+/g, ' '))`,
            )
            .catch(() => {});
        }, 400);
      }
      if (process.env.INTEL_BROADCAST_SETTINGS_AUTOSAVE_JSON) {
        setTimeout(() => {
          settingsWin.webContents
            .executeJavaScript(`window.settingsAPI.save(${process.env.INTEL_BROADCAST_SETTINGS_AUTOSAVE_JSON})`)
            // The window closes right after a save is applied, which can reject
            // this promise mid-flight — expected, not a test failure.
            .catch(() => {});
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
  const initialPosition = isGmMode() ? { x: 80, y: 80 } : { x: 460, y: 200 };
  viewer = createViewerWindow({ title: config.windowTitle, initialPosition, uiScale: config.uiScale });

  if (process.env.INTEL_BROADCAST_SCREENSHOT_PATH) attachDevScreenshotHook(viewer);

  registerHotkeys();

  if (isGmMode()) {
    startGmRole();
  } else {
    startViewerRole();
  }

  // Dev/test-only: lets a test harness trigger the same reveal action a real
  // hotkey press would, without simulating an OS-level keypress. Created
  // regardless of current mode (a test can flip GM mode on live, then
  // trigger). Never started unless this env var is explicitly set.
  if (process.env.INTEL_BROADCAST_TEST_TRIGGER_PORT) {
    http
      .createServer((req, res) => {
        doReveal();
        res.end('ok');
      })
      .listen(Number(process.env.INTEL_BROADCAST_TEST_TRIGGER_PORT), '127.0.0.1');
  }

  viewer.window.on('closed', () => {
    stopViewerRole();
    stopGmRole();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
