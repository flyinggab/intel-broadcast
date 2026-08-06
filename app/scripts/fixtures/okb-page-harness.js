'use strict';

// Loads the EFB exactly as OpenKneeboard's WebView2 does — over http from the
// dashboard server, with no Electron preload — and reports what it did.
//
// The stub for `window.OpenKneeboard` is injected through a preload rather
// than executeJavaScript, because okb-bridge.js checks for it at parse time:
// injected any later, the bridge has already decided it is on the Electron
// surface and installed nothing. `contextIsolation: false` is what lets the
// preload write a real `window.OpenKneeboard` the page can see; this is a test
// fixture on a loopback URL, not a shipped window.
//
// Usage: electron scripts/fixtures/okb-page-harness.js --port <n>

const path = require('path');
const { app, BrowserWindow } = require('electron');

const portIndex = process.argv.indexOf('--port');
const PORT = portIndex !== -1 ? Number(process.argv[portIndex + 1]) : 8811;

app.on('window-all-closed', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What the page believes about itself, from its own globals. */
async function readPage(win) {
  return win.webContents.executeJavaScript(`(() => ({
    surface: document.body.dataset.surface,
    okbActive: Boolean(window.__okb && window.__okb.active),
    socket: window.__okb ? window.__okb.socket : null,
    hasApi: typeof window.viewerAPI === 'object' && window.viewerAPI !== null,
    stageSrc: document.getElementById('stage-img').getAttribute('src') || '',
    standby: !document.getElementById('stage-standby').classList.contains('is-hidden'),
    crumb: document.getElementById('crumb-page').textContent,
  }))()`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900,
    height: 1100,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'okb-stub-preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => console.log(`OKBPAGE_LOADFAIL ${code} ${desc}`));

  try {
    await win.loadURL(`http://127.0.0.1:${PORT}/viewer.html`);
    await sleep(1500); // socket open + first snapshot
    const connected = await readPage(win);
    console.log('OKBPAGE_CONNECTED ' + JSON.stringify(connected));

    // The app restarting under a tab that stays open all flight is the case
    // that decides whether a pilot has to touch anything. Reported so the test
    // can assert on it rather than on the reconnect code being present.
    console.log('OKBPAGE_MARK server-down');
    await sleep(2500);
    const dropped = await readPage(win);
    console.log('OKBPAGE_DROPPED ' + JSON.stringify(dropped));

    console.log('OKBPAGE_MARK server-up');
    await sleep(9000); // the bridge backs off to 5s between attempts
    const back = await readPage(win);
    console.log('OKBPAGE_RECONNECTED ' + JSON.stringify(back));
  } catch (err) {
    console.log(`OKBPAGE_ERROR ${err.message}`);
  }
  win.destroy();
  app.quit();
});
