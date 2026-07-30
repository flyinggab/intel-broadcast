'use strict';

// Settings smoke test: spawns the real Electron app with the settings window
// auto-opened and a real save driven through the actual
// preload/contextBridge/ipcRenderer.invoke/ipcMain.handle path (not a
// shortcut around it), then confirms:
//   1. config.local.json ends up with exactly the values that path saved;
//   2. the save applied LIVE — the process must NOT exit/relaunch, and the
//      new GM-mode + hotkey values must be picked up by the same process;
//   3. a pre-existing key the form doesn't know about (uiScale) survives the
//      save's deep merge;
//   4. the uiScale-driven zoom from scaling.js is actually applied in the
//      renderer (ZOOM_PROBE reports the settings window's innerWidth, which
//      shrinks by the zoom factor relative to the window's outer width).
//
// Usage: node scripts/dev-e2e-settings-test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');
const { LOCAL_CONFIG_PATH } = require('../src/main/config');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');

const UI_SCALE = 1.6; // pre-seeded so the zoom probe checks a non-trivial factor

const SAVE_PAYLOAD = {
  relayHostEnabled: true,
  photosFolder: '/tmp/some-mission-photos',
  token: 'settings-e2e-token',
  gm: { relayPort: 9123 },
  hotkeys: { reveal: 'Ctrl+Shift+U', next: 'Ctrl+Shift+Right', prev: 'Ctrl+Shift+Left' },
};

fs.rmSync(LOCAL_CONFIG_PATH, { force: true });
fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify({ uiScale: UI_SCALE }, null, 2));

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
    detached: true, // process GROUP, so killTree reaches the real binary
  env: {
    ...process.env,
    INTEL_BROADCAST_OPEN_SETTINGS: '1',
    INTEL_BROADCAST_SETTINGS_AUTOSAVE_JSON: JSON.stringify(SAVE_PAYLOAD),
    INTEL_BROADCAST_ZOOM_PROBE: '1',
    // Ticks only while the settings window is alive — used below to prove the
    // window survives a save.
    INTEL_BROADCAST_CLIENTS_PROBE: '1',
  },
});

let output = '';
let stderr = '';
child.stdout.on('data', (d) => {
  output += d.toString();
  process.stdout.write(`[electron] ${d}`);
});
child.stderr.on('data', (d) => {
  stderr += d.toString();
  process.stderr.write(`[electron] ${d}`);
});

function finish(exitCode) {
  fs.rmSync(LOCAL_CONFIG_PATH, { force: true });
  killApp(child);
  setTimeout(() => process.exit(exitCode), 200);
}

// The old flow exited the app after a save (relaunch-to-apply); the live-apply
// flow must keep the same process running. An early exit is now a failure.
child.on('exit', (code) => {
  console.error(`[e2e] FAIL: app exited (code ${code}) — a save must apply live, not restart`);
  finish(1);
});

const deadline = Date.now() + 20000;
const poll = setInterval(() => {
  const saved =
    fs.existsSync(LOCAL_CONFIG_PATH) &&
    (() => {
      try {
        return JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8')).token === SAVE_PAYLOAD.token;
      } catch {
        return false;
      }
    })();
  const applied =
    output.includes('hosting enabled — embedded relay started') &&
    output.includes('register reveal "Ctrl+Shift+U": OK');

  if (saved && applied) {
    clearInterval(poll);
    child.removeAllListeners('exit');
    try {
      assert.strictEqual(child.exitCode, null, 'app must still be running (no relaunch)');

      const written = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
      assert.strictEqual(written.relayHostEnabled, true);
      assert.strictEqual(written.photosFolder, SAVE_PAYLOAD.photosFolder);
      assert.strictEqual(written.token, SAVE_PAYLOAD.token);
      assert.strictEqual(written.gm.relayPort, SAVE_PAYLOAD.gm.relayPort);
      assert.strictEqual(written.hotkeys.reveal, SAVE_PAYLOAD.hotkeys.reveal);
      assert.strictEqual(written.uiScale, UI_SCALE, 'pre-existing uiScale must survive the merge');

      // Zoom probe: settings window outer width comes from the main-process
      // log, renderer innerWidth from the probe — innerWidth should be the
      // outer width divided by the zoom factor (small slop for frame borders
      // and a possible scrollbar).
      const winMatch = output.match(/\[settingsWindow\] window (\d+)x(\d+), zoom ([\d.]+)/);
      const probeMatch = output.match(/ZOOM_PROBE innerWidth=([\d.]+) dpr=([\d.]+)/);
      assert.ok(winMatch, 'settings window size/zoom log line present');
      assert.ok(probeMatch, 'ZOOM_PROBE line present');
      const outerWidth = Number(winMatch[1]);
      const zoom = Number(winMatch[3]);
      const innerWidth = Number(probeMatch[1]);
      assert.ok(Math.abs(zoom - UI_SCALE) < 0.01, `window created with zoom ${zoom}, expected ${UI_SCALE}`);
      const expectedInner = outerWidth / zoom;
      assert.ok(
        Math.abs(innerWidth - expectedInner) < 40,
        `renderer innerWidth ${innerWidth} should be ~${expectedInner.toFixed(0)} (outer ${outerWidth} / zoom ${zoom}) — zoom not applied?`,
      );

      assert.ok(!/Uncaught|TypeError|ReferenceError/.test(stderr), 'no uncaught renderer/main errors');

      // The settings window must STAY OPEN after a save. It used to close
      // (a leftover from restart-to-apply), which hid the Tailscale panel
      // exactly when a save had just produced the public URL — the user hit
      // this as "I ticked the box, nothing changed, where's my URL?".
      // CLIENTS_PROBE only ticks while the window is alive.
      // Note: probesBefore may legitimately be 0 — the save can be detected
      // before the first 400ms probe tick. What matters is that ticks keep
      // coming AFTER the save, which only happens if the window is alive.
      const probesBefore = (output.match(/CLIENTS_PROBE/g) || []).length;
      setTimeout(() => {
        try {
          const probesAfter = (output.match(/CLIENTS_PROBE/g) || []).length;
          assert.ok(
            probesAfter > probesBefore,
            `settings window closed after saving (probe ticks stopped at ${probesBefore}) — it must stay open so the Tailscale panel can show the result`,
          );
          console.log('[e2e] PASS: save applied live, window stayed open, config merged, zoom applied');
          finish(0);
        } catch (err) {
          console.error(`[e2e] FAIL: ${err.message}`);
          finish(1);
        }
      }, 1500);
    } catch (err) {
      console.error(`[e2e] FAIL: ${err.message}`);
      finish(1);
    }
  } else if (Date.now() > deadline) {
    clearInterval(poll);
    console.error(`[e2e] FAIL: timed out (saved=${saved} applied=${applied})`);
    finish(1);
  }
}, 300);
