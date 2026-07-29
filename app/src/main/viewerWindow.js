'use strict';

const path = require('path');
const { BrowserWindow, globalShortcut } = require('electron');

/**
 * Creates the OpenKneeboard-Window-Capture-friendly viewer window, and
 * registers this pilot's own local next/prev browsing hotkeys (never touches
 * the network — purely local UI state in the renderer). Uses a normal, framed
 * OS window — OpenKneeboard's Window Capture doesn't need a frameless window
 * (it captures WhatsApp, which has a titlebar, without issue), and a normal
 * frame gets drag/resize/minimize for free instead of reimplementing it.
 */
// A4 portrait proportions (210mm x 297mm, ~1:1.4142) — matches kneeboard-page
// orientation rather than a landscape default.
const A4_PORTRAIT_WIDTH = 850;
const A4_PORTRAIT_HEIGHT = 1202;

function createViewerWindow({ title, hotkeys, initialPosition }) {
  const window = new BrowserWindow({
    title,
    width: A4_PORTRAIT_WIDTH,
    height: A4_PORTRAIT_HEIGHT,
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

  window.loadFile(path.join(__dirname, '..', 'renderer', 'viewer', 'index.html'));

  if (hotkeys.next) {
    const ok = globalShortcut.register(hotkeys.next, () => window.webContents.send('navigate', 'next'));
    console.log(`[viewerWindow] register next "${hotkeys.next}": ${ok ? 'OK' : 'FAILED (already taken by another app?)'}`);
  }
  if (hotkeys.prev) {
    const ok = globalShortcut.register(hotkeys.prev, () => window.webContents.send('navigate', 'prev'));
    console.log(`[viewerWindow] register prev "${hotkeys.prev}": ${ok ? 'OK' : 'FAILED (already taken by another app?)'}`);
  }

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

  return { window, showBatch, setConnectionState };
}

module.exports = { createViewerWindow };
