'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, ipcMain, dialog, screen } = require('electron');
const { LOCAL_CONFIG_PATH } = require('./config');
const { computeSettingsBounds } = require('./scaling');

let settingsWindow = null;

/**
 * Merges `values` into the existing config.local.json (deep-merging hotkeys/gm
 * like config.js's loadConfig() does, so a save that only touches some keys
 * can't clobber previously-saved ones in those nested objects) and writes it.
 * Pure file I/O, no Electron dependency — kept separate from the ipcMain
 * wiring below so it's testable with plain Node.
 */
function saveSettingsValues(values) {
  let existing = {};
  if (fs.existsSync(LOCAL_CONFIG_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
    } catch {
      existing = {};
    }
  }
  const merged = {
    ...existing,
    ...values,
    hotkeys: { ...(existing.hotkeys || {}), ...(values.hotkeys || {}) },
    gm: { ...(existing.gm || {}), ...(values.gm || {}) },
  };
  fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

/**
 * Registers the IPC handlers the settings renderer talks to. Call once at
 * startup. `onSaved` is index.js's live-apply entry point: it re-loads the
 * config and restarts whatever the changed values affect (hotkeys, relay
 * server, relay client) in-process — saves no longer relaunch the app.
 * `onTailscaleAction` handles the Tailscale panel's buttons (login, open
 * download/admin pages, copy invite, refresh).
 */
function registerSettingsIpc({ onSaved, onTailscaleAction = () => {} }) {
  ipcMain.handle('settings:browse-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('settings:tailscale-action', (_event, action) => onTailscaleAction(String(action)));

  ipcMain.handle('settings:save', (_event, values) => {
    saveSettingsValues(values);
    onSaved();
    // Close after the invoke's reply has gone back to the renderer, so its
    // save() promise resolves instead of dying with the window.
    setImmediate(() => {
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
    });
  });
}

/**
 * Pushes a fresh connected-clients list ([{role, callsign, connectedAt}]) to
 * the settings window, if one is open. No-op otherwise — the window gets a
 * current snapshot in its init payload when (re)opened.
 */
function pushConnectedClients(clients) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('connected-clients', clients);
  }
}

/** Pushes a fresh Tailscale state snapshot (see tailscale.js getState()) to
 *  the settings window, if one is open. */
function pushTailscaleState(state) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('tailscale-state', state);
  }
}

/** Opens the settings window (or focuses it if already open). */
function openSettingsWindow({ isHost, config, getConnectedClients = () => [] }) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }

  const { width, height, zoom } = computeSettingsBounds(
    screen.getPrimaryDisplay().workAreaSize,
    config.uiScale,
  );
  console.log(`[settingsWindow] window ${width}x${height}, zoom ${zoom.toFixed(2)}`);

  settingsWindow = new BrowserWindow({
    title: 'Intel Broadcast Settings',
    width,
    height,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html'), {
    query: { uiZoom: String(zoom) },
  });
  settingsWindow.webContents.on('did-finish-load', () => {
    settingsWindow.webContents.send('init', { isHost, config, connectedClients: getConnectedClients() });
  });

  return settingsWindow;
}

module.exports = {
  openSettingsWindow,
  registerSettingsIpc,
  saveSettingsValues,
  pushConnectedClients,
  pushTailscaleState,
};
