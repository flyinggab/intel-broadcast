'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Main computes a per-display scale (scaling.js) and passes it on the load
// URL. Written to --ui-scale, NOT webFrame zoom: every dimension in the UI is
// rem off this one custom property, so the whole interface follows it and a
// second surface (the VR quad in phase 4) can scale independently.
const uiScale = Number(new URLSearchParams(location.search).get('uiScale'));
if (uiScale > 0) {
  const apply = () => document.documentElement.style.setProperty('--ui-scale', String(uiScale));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
}


contextBridge.exposeInMainWorld('settingsAPI', {
  onState: (callback) => ipcRenderer.on('state', (_event, snapshot) => callback(snapshot)),
  send: (intent, payload) => ipcRenderer.send('settings:intent', intent, payload),
  // Decoding runs in main so the squad-code parser has exactly one
  // implementation, and so a pasted code is validated before any socket opens.
  decodeCode: (raw) => ipcRenderer.invoke('settings:decode-code', raw),
  readClipboard: () => ipcRenderer.invoke('settings:read-clipboard'),
});
