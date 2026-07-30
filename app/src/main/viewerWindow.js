'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { computeViewerBounds } = require('./scaling');

/**
 * Creates the OpenKneeboard-Window-Capture-friendly viewer window. Uses a
 * normal, framed OS window — OpenKneeboard's Window Capture doesn't need a
 * frameless window (it captures WhatsApp, which has a titlebar, without
 * issue), and a normal frame gets drag/resize/minimize for free instead of
 * reimplementing it.
 *
 * A4-portrait proportions (210mm x 297mm, ~1:1.4142 — kneeboard-page
 * orientation), sized relative to the display's work area so it looks the
 * same on a 4K screen as on 1080p instead of rendering tiny (see scaling.js).
 * Next/prev browsing hotkeys are registered centrally by index.js (so a
 * settings save can re-register them live) and arrive via navigate().
 */
function createViewerWindow({ title, initialPosition, uiScale }) {
  const display = initialPosition
    ? screen.getDisplayNearestPoint(initialPosition)
    : screen.getPrimaryDisplay();
  const { width, height, zoom } = computeViewerBounds(display.workAreaSize, uiScale);
  console.log(
    `[viewerWindow] work area ${display.workAreaSize.width}x${display.workAreaSize.height} -> window ${width}x${height}, zoom ${zoom.toFixed(2)}`,
  );

  const window = new BrowserWindow({
    title,
    width,
    height,
    ...(initialPosition ? { x: initialPosition.x, y: initialPosition.y } : {}),
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'viewer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Fixed title set once at creation and never mutated afterwards, per design —
  // OpenKneeboard's Window Capture source targets it at configuration time.
  window.setTitle(title);

  window.loadFile(path.join(__dirname, '..', 'renderer', 'viewer', 'index.html'), {
    query: { uiZoom: String(zoom) },
  });

  function toDataUrl(item) {
    return `data:${item.mimeType};base64,${item.buffer.toString('base64')}`;
  }

  function showBatch(batch) {
    if (window.isDestroyed()) return; // relayClient events can still land during shutdown
    window.webContents.send('show-batch', {
      batchId: batch.batchId,
      items: batch.items.map((item) => ({ filename: item.filename, dataUrl: toDataUrl(item) })),
    });
  }

  function setConnectionState(state) {
    if (window.isDestroyed()) return; // e.g. the 'disconnected' event firing after window close
    window.webContents.send('connection-state', state);
  }

  function navigate(direction) {
    if (window.isDestroyed()) return;
    window.webContents.send('navigate', direction);
  }

  return { window, showBatch, setConnectionState, navigate };
}

module.exports = { createViewerWindow };
