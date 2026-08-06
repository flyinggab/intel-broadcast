'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { computeViewerBounds } = require('./scaling');

/**
 * The OpenKneeboard-capture-friendly viewer window. FRAMELESS: Window Capture
 * takes the whole window, so an OS title bar rides on the pilot's knee for the
 * entire flight. The app draws its own controls in the strip instead, which
 * costs the drag/resize/minimise a frame gives for free — see `frame: false`
 * below and `.wctl` / `-webkit-app-region` in components.css.
 *
 * The window still has a TITLE even without a bar to draw it in, which is what
 * OpenKneeboard's Window Capture matches on.
 *
 * A4-portrait proportions sized off the display's work area (see scaling.js),
 * so it looks the same on a 4K screen as on 1080p. The kneeboard aspect is
 * config today and becomes a real choice in phase 4, when we render the quad
 * ourselves rather than inheriting the shape from window capture.
 *
 * The window is a pure renderer: it receives state snapshots via pushState()
 * and emits intents. It holds no view state of its own.
 */
function createViewerWindow({ title, initialPosition, uiScale, onState = () => {} }) {
  const display = initialPosition ? screen.getDisplayNearestPoint(initialPosition) : screen.getPrimaryDisplay();
  const { width, height, zoom } = computeViewerBounds(display.workAreaSize, uiScale);
  console.log(
    `[viewerWindow] work area ${display.workAreaSize.width}x${display.workAreaSize.height} -> window ${width}x${height}, scale ${zoom.toFixed(2)}`,
  );

  const window = new BrowserWindow({
    title,
    width,
    height,
    // No OS frame. OpenKneeboard's Window Capture takes the whole window, so
    // a title bar is a strip of Windows chrome sitting on a pilot's knee for
    // the entire flight. The app draws its own controls in the strip instead
    // (`.wctl`), which also means they vanish with the rest of the chrome
    // under capture-clean, and the drag handle is the strip's status text —
    // see the -webkit-app-region note in components.css.
    //
    // `thickFrame` stays default (true): it is what keeps the invisible
    // resize border on Windows, and a frameless window that cannot be resized
    // is a worse trade than the one being made here.
    frame: false,
    // Windows/Linux draw this in the title bar and taskbar; macOS ignores it
    // and uses the bundle's .icns instead.
    icon: path.join(__dirname, '..', 'renderer', 'img', 'icon.png'),
    ...(initialPosition ? { x: initialPosition.x, y: initialPosition.y } : {}),
    backgroundColor: '#747A74',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'viewer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Fixed title, set once and never mutated — OpenKneeboard's Window Capture
  // source targets it at configuration time.
  window.setTitle(title);

  window.loadFile(path.join(__dirname, '..', 'renderer', 'viewer.html'), {
    query: { uiScale: String(zoom) },
  });

  // Push the current state as soon as the renderer can receive it, so a reload
  // repaints from main rather than from anything the DOM remembered.
  window.webContents.on('did-finish-load', () => onState());

  function pushState(snapshot) {
    if (window.isDestroyed()) return;
    window.webContents.send('state', snapshot);
  }

  return { window, pushState };
}

module.exports = { createViewerWindow };
