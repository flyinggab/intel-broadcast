'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Main computes a per-display zoom (see scaling.js) and passes it via the
// load URL's query string. Applied with webFrame — NOT webContents zoom,
// which Chromium scopes per-origin: both windows load from file://, so a
// webContents zoom set for one would silently retarget the other too.
const uiZoom = Number(new URLSearchParams(location.search).get('uiZoom'));
if (uiZoom > 0) webFrame.setZoomFactor(uiZoom);

contextBridge.exposeInMainWorld('viewerAPI', {
  onShowBatch: (callback) => ipcRenderer.on('show-batch', (_event, batch) => callback(batch)),
  onConnectionState: (callback) => ipcRenderer.on('connection-state', (_event, state) => callback(state)),
  onNavigate: (callback) => ipcRenderer.on('navigate', (_event, direction) => callback(direction)),
});
