'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { computeViewerBounds } = require('./scaling');

/**
 * The OpenKneeboard-capture-friendly viewer window. Normal framed window —
 * Window Capture handles those fine, and a frame gets drag/resize/minimize for
 * free.
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
