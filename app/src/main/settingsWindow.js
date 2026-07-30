'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, ipcMain, dialog, screen, shell } = require('electron');
const { LOCAL_CONFIG_PATH } = require('./config');
const { computeSettingsBounds } = require('./scaling');
const { getLogFilePath } = require('./logger');

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

  // Packaged builds have no console, so the log file is the only way a user
  // can show us what actually happened. Reveal it in the file manager rather
  // than opening it, so it can be attached to a report.
  ipcMain.handle('settings:open-log', () => {
    const logPath = getLogFilePath();
    if (logPath) shell.showItemInFolder(logPath);
  });

  ipcMain.handle('settings:save', (_event, values) => {
    // A save that can't be written must never look like it worked — that was
    // the v0.2.0 packaging bug (config path inside the read-only asar), where
    // every setting appeared to be accepted and silently vanished.
    try {
      saveSettingsValues(values);
    } catch (err) {
      console.error(`[settings] SAVE FAILED writing ${LOCAL_CONFIG_PATH}: ${err.message}`);
      return { ok: false, error: `Could not save to ${LOCAL_CONFIG_PATH}: ${err.message}` };
    }
    console.log(`[settings] saved to ${LOCAL_CONFIG_PATH}`);
    onSaved();
    // The window deliberately STAYS OPEN. It used to close here, left over
    // from when saving relaunched the app — but with live apply that hid the
    // very thing a save produces: the Tailscale panel's public URL (or the
    // error explaining why there isn't one) lands moments after this returns.
    return { ok: true };
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
    settingsWindow.webContents.send('init', {
      isHost,
      config,
      connectedClients: getConnectedClients(),
      logPath: getLogFilePath(),
    });
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
