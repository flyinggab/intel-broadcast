'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, ipcMain, dialog, screen } = require('electron');
const { LOCAL_CONFIG_PATH } = require('./config');
const { computeSettingsBounds } = require('./scaling');

let settingsWindow = null;

/**
 * Merges `values` into config.local.json (deep-merging hotkeys/gm like
 * loadConfig() does, so a save touching some keys can't clobber others) and
 * writes it. Returns the merged config so callers can apply it directly.
 *
 * Throws if the file cannot be written — that must never look like success.
 * In a packaged build this path is under userData; writing next to the app
 * would land inside the read-only asar, which is exactly the bug that shipped
 * in v0.2.0 and made every setting silently vanish.
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
  console.log(`[settings] saved to ${LOCAL_CONFIG_PATH}`);
  // Re-load through config.js so defaults and the legacy-key migration apply.
  return require('./config').loadConfig();
}

function registerSettingsIpc() {
  ipcMain.handle('settings:browse-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}

/** Native folder picker, parented to the settings window if it's open. */
async function browseFolder() {
  const result = await dialog.showOpenDialog(
    settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : undefined,
    { properties: ['openDirectory'] },
  );
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
}

function isSettingsOpen() {
  return Boolean(settingsWindow && !settingsWindow.isDestroyed());
}

/** Pushes a complete state snapshot; the renderer owns nothing (ROADMAP §5.2). */
function pushSettingsState(snapshot) {
  if (isSettingsOpen()) settingsWindow.webContents.send('state', snapshot);
}

/** Opens the settings window (or focuses it if already open). */
function openSettingsWindow({ config }) {
  if (isSettingsOpen()) {
    settingsWindow.focus();
    return settingsWindow;
  }

  const { width, height, zoom } = computeSettingsBounds(screen.getPrimaryDisplay().workAreaSize, config.uiScale);
  console.log(`[settingsWindow] window ${width}x${height}, scale ${zoom.toFixed(2)}`);

  settingsWindow = new BrowserWindow({
    title: 'Intel Broadcast Setup',
    width,
    height,
    icon: path.join(__dirname, '..', 'renderer', 'img', 'icon.png'),
    resizable: true,
    backgroundColor: '#747A74',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'), {
    query: { uiScale: String(zoom) },
  });

  return settingsWindow;
}

// browseFolder hangs off the opener so index.js can reach it without another
// import; it needs the same window reference.
openSettingsWindow.browseFolder = browseFolder;

module.exports = {
  openSettingsWindow,
  registerSettingsIpc,
  saveSettingsValues,
  pushSettingsState,
  isSettingsOpen,
};
