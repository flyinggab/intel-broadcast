'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, ipcMain, dialog, app, globalShortcut } = require('electron');
const { LOCAL_CONFIG_PATH } = require('./config');

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

/** Registers the IPC handlers the settings renderer talks to. Call once at startup. */
function registerSettingsIpc() {
  ipcMain.handle('settings:browse-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('settings:save', (_event, values) => {
    saveSettingsValues(values);
    // app.exit() (needed for an immediate restart) does NOT fire 'will-quit'
    // the way app.quit() does, so the app-level cleanup handler that
    // unregisters hotkeys on normal quit never runs on this path — without
    // this explicit call, the old process's hotkey registrations could still
    // be held during the handoff to the relaunched process.
    globalShortcut.unregisterAll();
    // Dev/test-only: skips the relaunch so an automated test doesn't spawn an
    // orphaned second instance it then has to hunt down and kill.
    if (!process.env.INTEL_BROADCAST_NO_RELAUNCH) app.relaunch();
    app.exit(0);
  });
}

/** Opens the settings window (or focuses it if already open). */
function openSettingsWindow({ isGmMode, config }) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    title: 'Intel Broadcast Settings',
    width: 480,
    height: isGmMode ? 640 : 460,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html'));
  settingsWindow.webContents.on('did-finish-load', () => {
    settingsWindow.webContents.send('init', { isGmMode, config });
  });

  return settingsWindow;
}

module.exports = { openSettingsWindow, registerSettingsIpc, saveSettingsValues };
