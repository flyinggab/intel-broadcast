'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Main computes a per-display zoom (see scaling.js) and passes it via the
// load URL's query string. Applied with webFrame — NOT webContents zoom,
// which Chromium scopes per-origin: both windows load from file://, so a
// webContents zoom set for one would silently retarget the other too.
const uiZoom = Number(new URLSearchParams(location.search).get('uiZoom'));
if (uiZoom > 0) webFrame.setZoomFactor(uiZoom);

contextBridge.exposeInMainWorld('settingsAPI', {
  onInit: (callback) => ipcRenderer.on('init', (_event, payload) => callback(payload)),
  onConnectedClients: (callback) => ipcRenderer.on('connected-clients', (_event, clients) => callback(clients)),
  onTailscaleState: (callback) => ipcRenderer.on('tailscale-state', (_event, state) => callback(state)),
  browseFolder: () => ipcRenderer.invoke('settings:browse-folder'),
  tailscaleAction: (action) => ipcRenderer.invoke('settings:tailscale-action', action),
  save: (values) => ipcRenderer.invoke('settings:save', values),
});
