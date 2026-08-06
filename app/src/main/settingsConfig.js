'use strict';

const fs = require('fs');
const { dialog } = require('electron');
const { LOCAL_CONFIG_PATH } = require('./config');

// What is left of the old settingsWindow.js. SETUP is a page of the viewer
// now — the EFB carries its own settings, like the tablet a pilot actually
// flies with — so there is no window to open, focus, push state to or ask
// whether it is open. Two jobs remain: write the config file, and put a
// native folder picker on screen.

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
    // Every nested object needs its own merge, or writing one key of it drops
    // the rest: toggling okb.enabled would silently take okb.port with it.
    okb: { ...(existing.okb || {}), ...(values.okb || {}) },
  };
  fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(merged, null, 2));
  console.log(`[settings] saved to ${LOCAL_CONFIG_PATH}`);
  // Re-load through config.js so defaults and the legacy-key migration apply.
  return require('./config').loadConfig();
}

/** Native folder picker, parented to the one window there is. */
async function browseFolder(parent) {
  const result = await dialog.showOpenDialog(
    parent && !parent.isDestroyed() ? parent : undefined,
    { properties: ['openDirectory'] },
  );
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
}

module.exports = { saveSettingsValues, browseFolder };
