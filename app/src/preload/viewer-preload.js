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


// The renderer receives complete state snapshots and sends back intents —
// never decisions (ROADMAP §5.2). Scaling is applied by main writing the
// --ui-scale CSS variable, not by zooming the frame, so every rem-based
// dimension follows one number.
contextBridge.exposeInMainWorld('viewerAPI', {
  onState: (callback) => ipcRenderer.on('state', (_event, snapshot) => callback(snapshot)),
  send: (intent, payload) => ipcRenderer.send('viewer:intent', intent, payload),
});
