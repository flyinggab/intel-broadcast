'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, ipcMain, dialog, app } = require('electron');
const { LOCAL_CONFIG_PATH } = require('./config');

let settingsWindow = null;

/** Registers the IPC handlers the settings renderer talks to. Call once at startup. */
function registerSettingsIpc() {
  ipcMain.handle('settings:browse-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('settings:save', (_event, values) => {
    let existing = {};
    if (fs.existsSync(LOCAL_CONFIG_PATH)) {
      try {
        existing = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
      } catch {
        existing = {};
      }
    }
    fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify({ ...existing, ...values }, null, 2));
    app.relaunch();
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

module.exports = { openSettingsWindow, registerSettingsIpc };
