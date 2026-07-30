'use strict';

const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');

// The menu-bar icon, generated from branding/tray-template.svg.
//
// "Template" in the filename is load-bearing: AppKit only applies template
// behaviour — recolour for light/dark menu bars — to images named that way,
// and nativeImage picks up the @2x sibling automatically. The artwork is
// therefore black + alpha only; any colour in it would fight the OS.
const TRAY_ICON = path.join(__dirname, '..', 'renderer', 'img', 'trayTemplate.png');

/**
 * Creates the system tray icon with a "Settings"/"Quit" context menu — the
 * only way to reach settings since the app deliberately has no menu bar.
 * Returns null (and logs) instead of throwing if Tray isn't supported on
 * this platform/session, so it can never take the whole app down.
 */
function createTray({ onOpenSettings, t = (key) => key }) {
  try {
    const image = nativeImage.createFromPath(TRAY_ICON);
    image.setTemplateImage(true);
    const tray = new Tray(image);
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
