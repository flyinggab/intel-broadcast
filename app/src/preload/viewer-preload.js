'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viewerAPI', {
  onShowBatch: (callback) => ipcRenderer.on('show-batch', (_event, batch) => callback(batch)),
  onConnectionState: (callback) => ipcRenderer.on('connection-state', (_event, state) => callback(state)),
  onNavigate: (callback) => ipcRenderer.on('navigate', (_event, direction) => callback(direction)),
});
