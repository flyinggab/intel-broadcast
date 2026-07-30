'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');

// Minimal placeholder 1x1 PNG so we don't depend on an external icon asset
// file existing on disk. TODO: swap for a real icon before distributing —
// this renders as a small solid square, functional but not polished.
const PLACEHOLDER_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/**
 * Creates the system tray icon with a "Settings"/"Quit" context menu — the
 * only way to reach settings since the app deliberately has no menu bar.
 * Returns null (and logs) instead of throwing if Tray isn't supported on
 * this platform/session, so it can never take the whole app down.
 */
function createTray({ onOpenSettings, t = (key) => key }) {
  try {
    const tray = new Tray(nativeImage.createFromDataURL(PLACEHOLDER_ICON_DATA_URL));
    tray.setToolTip('Intel Broadcast');
    const buildMenu = (translate) =>
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: translate('menu.settings'), click: onOpenSettings },
          { type: 'separator' },
          { label: translate('menu.quit'), click: () => app.quit() },
        ]),
      );
    buildMenu(t);
    // A tray menu is built once and cached by the OS, so a locale change has
    // to rebuild it — nothing re-renders it the way a snapshot does.
    tray.retranslate = buildMenu;
    return tray;
  } catch (err) {
    console.error(`[tray] failed to create tray icon (unsupported on this platform/session?): ${err.message}`);
    return null;
  }
}

module.exports = { createTray };
