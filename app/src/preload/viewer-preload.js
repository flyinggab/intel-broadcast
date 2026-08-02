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
  // SETUP is a page in this window — the EFB carries its own settings, the
  // way the tablet a pilot actually flies with does. These two were the
  // settings window's channels; they are the viewer's now.
  //
  // Decoding runs in main so the squad-code parser has exactly one
  // implementation, and so a pasted code is validated before any socket opens.
  decodeCode: (raw) => ipcRenderer.invoke('settings:decode-code', raw),
  readClipboard: () => ipcRenderer.invoke('settings:read-clipboard'),

  // Brief mode ink rides its OWN channel, not the state snapshot. At 30 Hz a
  // full snapshot per stroke frame would be absurd; these are deltas, and the
  // snapshot carries only a revision per image so a renderer that missed one
  // can notice and ask for the whole set back.
  onInk: (callback) => ipcRenderer.on('ink', (_event, delta) => callback(delta)),
  onInkSnapshot: (callback) => ipcRenderer.on('ink-snapshot', (_event, snap) => callback(snap)),
});
