'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  onInit: (callback) => ipcRenderer.on('init', (_event, payload) => callback(payload)),
  browseFolder: () => ipcRenderer.invoke('settings:browse-folder'),
  save: (values) => ipcRenderer.invoke('settings:save', values),
});
