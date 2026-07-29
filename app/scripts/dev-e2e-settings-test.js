'use strict';

// Phase (settings) smoke test: spawns the real Electron app with the settings
// window auto-opened and a real save driven through the actual
// preload/contextBridge/ipcRenderer.invoke/ipcMain.handle path (not a
// shortcut around it), then confirms config.local.json ended up with exactly
// the values that path was asked to save.
//
// Usage: node scripts/dev-e2e-settings-test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { LOCAL_CONFIG_PATH } = require('../src/main/config');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');

const SAVE_PAYLOAD = {
  gmModeEnabled: true,
  photosFolder: '/tmp/some-mission-photos',
  token: 'settings-e2e-token',
  gm: { relayPort: 9123 },
  hotkeys: { reveal: 'Ctrl+Shift+U', next: 'Ctrl+Shift+Right', prev: 'Ctrl+Shift+Left' },
};

fs.rmSync(LOCAL_CONFIG_PATH, { force: true });

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    INTEL_BROADCAST_OPEN_SETTINGS: '1',
    INTEL_BROADCAST_SETTINGS_AUTOSAVE_JSON: JSON.stringify(SAVE_PAYLOAD),
    INTEL_BROADCAST_NO_RELAUNCH: '1',
  },
});

let stderr = '';
child.stdout.on('data', (d) => process.stdout.write(`[electron] ${d}`));
child.stderr.on('data', (d) => {
  stderr += d.toString();
  process.stderr.write(`[electron] ${d}`);
});

function finish(exitCode) {
  fs.rmSync(LOCAL_CONFIG_PATH, { force: true });
  child.kill();
  setTimeout(() => process.exit(exitCode), 200);
}

child.on('exit', (code) => {
  // app.exit(0) is expected once the save handler runs — that's success, not
  // a crash. Give the file write a moment to be flushed/visible, then check it.
  setTimeout(() => {
    try {
      assert.ok(fs.existsSync(LOCAL_CONFIG_PATH), 'config.local.json should exist after save');
      const written = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
      assert.strictEqual(written.gmModeEnabled, true);
      assert.strictEqual(written.photosFolder, SAVE_PAYLOAD.photosFolder);
      assert.strictEqual(written.token, SAVE_PAYLOAD.token);
      assert.strictEqual(written.gm.relayPort, SAVE_PAYLOAD.gm.relayPort);
      assert.strictEqual(written.hotkeys.reveal, SAVE_PAYLOAD.hotkeys.reveal);
      assert.ok(!/Uncaught|TypeError|ReferenceError/.test(stderr), 'no uncaught renderer/main errors');
      console.log('[e2e] PASS: settings window saved via real IPC path, config.local.json matches');
      finish(0);
    } catch (err) {
      console.error(`[e2e] FAIL: ${err.message}`);
      finish(1);
    }
  }, 300);
});

setTimeout(() => {
  console.error('[e2e] FAIL: timed out waiting for the app to exit after save');
  finish(1);
}, 15000);
