'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { app, globalShortcut, Menu, shell, clipboard } = require('electron');
const { loadConfig } = require('./config');
const { createViewerWindow } = require('./viewerWindow');
const { RelayClient } = require('./relayClient');
const { createRelayServer } = require('./relayServer');
const { revealPhotosFolder } = require('./reveal');
const { createTray } = require('./tray');
const tailscale = require('./tailscale');
const {
  openSettingsWindow,
  registerSettingsIpc,
  pushConnectedClients,
  pushTailscaleState,
} = require('./settingsWindow');

const BUNDLED_PHOTOS_DIR = path.join(__dirname, '..', '..', 'photos');

// Mutable session state: a settings save re-loads `config` and live-restarts
// just the pieces the changed values affect (hotkey registrations, embedded
// relay server, relay client) via applyNewConfig() — no app relaunch.
//
// Unified mode: EVERY instance runs a RelayClient and can both share and
// receive. The instance with "Host the relay" checked additionally runs the
// embedded relay server (the center node — the only machine that needs
// Tailscale), and its own client simply connects to localhost.
let config = loadConfig();
let viewer = null;
let relayServer = null; // present iff this instance hosts the relay
let relayClient = null; // always present once the app is ready

function isHost() {
  return config.relayHostEnabled === true;
}

// The host's own client talks to its own embedded server; everyone else uses
// the configured (usually wss://…ts.net) relay URL.
function effectiveRelayUrl() {
  return isHost() ? `ws://127.0.0.1:${config.gm.relayPort}` : config.relayUrl;
}

// The settings page can point photosFolder at any arbitrary absolute path;
// falls back to the bundled test-fixture convention (photos/<mission-name>/)
// until it's been set once. Resolved at reveal time, so a folder change in
// Settings applies from the very next hotkey press.
function currentPhotosFolder() {
  return config.photosFolder || path.join(BUNDLED_PHOTOS_DIR, config.missionName);
}

function openSettings() {
  const win = openSettingsWindow({
    isHost: isHost(),
    config,
    getConnectedClients: () => (relayServer ? relayServer.getConnectedClients() : []),
  });
  // Keep the Tailscale panel fresh while the settings window is open — the
  // poll also auto-detects a just-completed install/login and (re)applies the
  // funnel whenever config wants it on but it isn't yet.
  if (!tailscalePollTimer) {
    refreshTailscaleState({ reconcile: true });
    tailscalePollTimer = setInterval(() => refreshTailscaleState({ reconcile: true }), 3000);
    win.on('closed', () => {
      clearInterval(tailscalePollTimer);
      tailscalePollTimer = null;
    });
  }
  return win;
}

function doReveal() {
  revealPhotosFolder({
    photosFolder: currentPhotosFolder(),
    relayClient,
    onLog: (msg) => console.log(`[reveal] ${msg}`),
  });
}

// ---------------------------------------------------------------------------
// Tailscale Funnel (host machine only) — the panel in Settings drives this.
// The funnel's lifetime follows the host session: reconciliation turns it on
// while `relayHostEnabled` + `gm.funnelEnabled` are both set, off otherwise,
// and will-quit shuts it down when the app exits.
// ---------------------------------------------------------------------------

let lastTailscaleState = null;
let tailscalePollTimer = null;
let lastFunnelAttempt = 0;
let loginInFlight = false;
// Failed funnel starts (e.g. waiting for the one-time admin-console enable)
// are retried on this cadence rather than every poll tick.
const FUNNEL_RETRY_MS = Number(process.env.INTEL_BROADCAST_FUNNEL_RETRY_MS) || 10000;

function wantFunnel() {
  return isHost() && config.gm.funnelEnabled === true;
}

/**
 * Fetches the current Tailscale state, optionally reconciling reality with
 * config (start the funnel if wanted-but-off, stop it if off-but-running),
 * and pushes the result to the settings window if one is open.
 */
async function refreshTailscaleState({ reconcile = false } = {}) {
  let state;
  try {
    state = await tailscale.getState();
    if (reconcile && wantFunnel() && state.installed && state.loggedIn && !state.funnelOn) {
      if (Date.now() - lastFunnelAttempt >= FUNNEL_RETRY_MS) {
        lastFunnelAttempt = Date.now();
        const res = await tailscale.startFunnel(config.gm.relayPort);
        if (res.ok) {
          console.log(`[tailscale] funnel started: public :443 -> 127.0.0.1:${config.gm.relayPort}`);
          state = await tailscale.getState();
        } else {
          state.enableUrl = res.enableUrl || null;
          state.error = res.message;
          console.log(`[tailscale] funnel start failed: ${res.message}`);
        }
      } else if (lastTailscaleState) {
        // between retries, keep showing the last error/enableUrl instead of
        // flickering back to a clean "not shared" state
        state.enableUrl = lastTailscaleState.enableUrl || null;
        state.error = lastTailscaleState.error || null;
      }
    } else if (reconcile && !wantFunnel() && state.funnelOn) {
      await tailscale.stopFunnel();
      console.log('[tailscale] funnel stopped (sharing disabled in settings)');
      state = await tailscale.getState();
    }
  } catch (err) {
    state = { installed: true, error: err.message };
  }
  lastTailscaleState = state;
  pushTailscaleState(state);
  return state;
}

/** Handles a button press from the settings panel's Tailscale section. */
async function handleTailscaleAction(action) {
  if (action === 'open-download') {
    shell.openExternal(tailscale.DOWNLOAD_URL);
    return;
  }
  if (action === 'open-enable-url') {
    if (lastTailscaleState && lastTailscaleState.enableUrl) shell.openExternal(lastTailscaleState.enableUrl);
    return;
  }
  if (action === 'login') {
    if (loginInFlight) return;
    loginInFlight = true;
    // Resolves when the CLI exits; the browser URL opens as soon as it's
    // printed. State polling picks up the resulting login either way.
    tailscale
      .login({ onAuthUrl: (url) => shell.openExternal(url) })
      .catch(() => {})
      .finally(() => {
        loginInFlight = false;
        refreshTailscaleState({ reconcile: true });
      });
    return;
  }
  if (action === 'copy-invite') {
    if (lastTailscaleState && lastTailscaleState.wssUrl) {
      clipboard.writeText(`Intel Broadcast relay: ${lastTailscaleState.wssUrl}\nToken: ${config.token}`);
    }
    return;
  }
  if (action === 'refresh') {
    lastFunnelAttempt = 0; // user asked — retry immediately
    await refreshTailscaleState({ reconcile: true });
  }
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
 * in the same step that claims the new ones. The reveal hotkey belongs to
 * everyone now, not just the host.
 */
function registerHotkeys() {
  globalShortcut.unregisterAll();
  registerHotkey('settings', config.hotkeys.settings, openSettings);
  registerHotkey('next', config.hotkeys.next, () => viewer.navigate('next'));
  registerHotkey('prev', config.hotkeys.prev, () => viewer.navigate('prev'));
  registerHotkey('reveal', config.hotkeys.reveal, doReveal);

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

function startHost() {
  relayServer = createRelayServer({
    port: config.gm.relayPort,
    token: config.token,
    onLog: (msg) => console.log(`[relay] ${msg}`),
    // Keeps the settings window's "Connected clients" section live while open.
    onClientsChanged: pushConnectedClients,
  });
}

/**
 * Tears down the embedded relay (terminating client sockets so the port is
 * released immediately) and calls `done` once it's fully closed — restarting
 * on the same port must wait for that, or it races into EADDRINUSE.
 */
function stopHost(done = () => {}) {
  if (!relayServer) {
    done();
    return;
  }
  const server = relayServer;
  relayServer = null;
  server.close(done);
}

function startClient() {
  relayClient = new RelayClient({
    url: effectiveRelayUrl(),
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
    // confirm this instance actually received a broadcast, without needing pixels.
    if (process.env.INTEL_BROADCAST_RECEIVED_MARKER_PATH) {
      fs.writeFileSync(
        process.env.INTEL_BROADCAST_RECEIVED_MARKER_PATH,
        JSON.stringify({
          batchId: batch.batchId,
          sharedBy: batch.sharedBy || '',
          filenames: batch.items.map((i) => i.filename),
        }),
      );
    }
  });

  // Until the first 'connected' fires this shows the disconnected banner —
  // truthful during a live settings change. At first boot the renderer
  // hasn't loaded yet and the message is simply dropped, same as before.
  viewer.setConnectionState({ connected: false });
  relayClient.connect();
}

/**
 * Closes the relay client and drops its listeners first, so the 'disconnected'
 * its closing socket emits asynchronously can't repaint the banner after a
 * replacement client has already taken over the connection state.
 */
function stopClient() {
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

  const wasHost = old.relayHostEnabled === true;
  const oldEffectiveUrl = wasHost ? `ws://127.0.0.1:${old.gm.relayPort}` : old.relayUrl;

  if (isHost() && !wasHost) {
    startHost();
    console.log('[index] hosting enabled — embedded relay started');
  } else if (!isHost() && wasHost) {
    stopHost();
    console.log('[index] hosting disabled — embedded relay stopped');
  } else if (isHost() && (old.gm.relayPort !== config.gm.relayPort || old.token !== config.token)) {
    stopHost(() => {
      startHost();
      console.log('[index] relay settings changed — embedded relay restarted');
    });
  }

  const clientChanged =
    oldEffectiveUrl !== effectiveRelayUrl() || old.token !== config.token || old.callsign !== config.callsign;
  if (clientChanged) {
    stopClient();
    startClient();
    console.log('[index] relay connection changed — reconnecting');
  }

  // A save is explicit user intent — reconcile the funnel against the new
  // config right away (and let a previously-failed start retry immediately).
  lastFunnelAttempt = 0;
  refreshTailscaleState({ reconcile: true });
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
  registerSettingsIpc({
    onSaved: () => applyNewConfig(loadConfig()),
    onTailscaleAction: handleTailscaleAction,
  });

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
      // Periodically reports the rendered Tailscale panel so a test can walk
      // the install -> login -> funnel-on states against the stub binary.
      if (process.env.INTEL_BROADCAST_TAILSCALE_PROBE) {
        const tsProbe = setInterval(() => {
          if (settingsWin.isDestroyed()) {
            clearInterval(tsProbe);
            return;
          }
          settingsWin.webContents
            .executeJavaScript(
              `console.log('TS_PROBE ' + document.getElementById('ts-status-text').textContent + ' | ' + document.getElementById('ts-url').textContent)`,
            )
            .catch(() => {});
        }, 400);
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
  // on the same machine (e.g. local testing) don't land exactly on top of
  // each other before you've dragged either one. Irrelevant once everyone is
  // on separate physical machines.
  const initialPosition = isHost() ? { x: 80, y: 80 } : { x: 460, y: 200 };
  viewer = createViewerWindow({ title: config.windowTitle, initialPosition, uiScale: config.uiScale });

  if (process.env.INTEL_BROADCAST_SCREENSHOT_PATH) attachDevScreenshotHook(viewer);

  registerHotkeys();

  if (isHost()) startHost();
  startClient();

  // Startup reconcile: bring the funnel up if this host wants it, and — since
  // `--bg` funnels survive reboots/crashes — tear down a leftover one when
  // config says it shouldn't be running.
  refreshTailscaleState({ reconcile: true });

  // Dev/test-only: lets a test harness trigger the same reveal action a real
  // hotkey press would, without simulating an OS-level keypress. Any instance
  // can share now, so any instance can carry this. Never started unless this
  // env var is explicitly set.
  if (process.env.INTEL_BROADCAST_TEST_TRIGGER_PORT) {
    http
      .createServer((req, res) => {
        doReveal();
        res.end('ok');
      })
      .listen(Number(process.env.INTEL_BROADCAST_TEST_TRIGGER_PORT), '127.0.0.1');
  }

  viewer.window.on('closed', () => {
    stopClient();
    stopHost();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Session-only funnel lifetime: the public endpoint goes away with the
  // host's app. Synchronous best-effort — will-quit can't await.
  if (wantFunnel()) tailscale.stopFunnelSync();
});

app.on('window-all-closed', () => {
  app.quit();
});
