'use strict';

// Unit test for settingsWindow.js's saveSettingsValues() — pure file I/O, no
// Electron needed. Checks the deep-merge behavior for hotkeys/gm specifically,
// since a naive shallow merge would let a save that only sets one hotkey wipe
// out previously-saved ones.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { saveSettingsValues } = require('../src/main/settingsWindow');
const { LOCAL_CONFIG_PATH } = require('../src/main/config');

function readLocal() {
  return JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
}

fs.rmSync(LOCAL_CONFIG_PATH, { force: true });

try {
  // First save: GM sets a folder, port, and only the reveal hotkey.
  saveSettingsValues({
    photosFolder: '/home/pilot/mission-photos',
    token: 'secret-1',
    gm: { relayPort: 9001 },
    hotkeys: { reveal: 'Ctrl+Shift+I' },
  });
  let cfg = readLocal();
  assert.strictEqual(cfg.photosFolder, '/home/pilot/mission-photos');
  assert.strictEqual(cfg.gm.relayPort, 9001);
  assert.strictEqual(cfg.hotkeys.reveal, 'Ctrl+Shift+I');
  console.log('[test] first save OK');

  // Second save: only sets next/prev hotkeys and a new token — must NOT wipe
  // out the reveal hotkey or relayPort from the first save.
  saveSettingsValues({
    token: 'secret-2',
    hotkeys: { next: 'Ctrl+Shift+Right', prev: 'Ctrl+Shift+Left' },
  });
  cfg = readLocal();
  assert.strictEqual(cfg.token, 'secret-2', 'token should update');
  assert.strictEqual(cfg.photosFolder, '/home/pilot/mission-photos', 'photosFolder should survive');
  assert.strictEqual(cfg.gm.relayPort, 9001, 'gm.relayPort should survive (deep merge)');
  assert.strictEqual(cfg.hotkeys.reveal, 'Ctrl+Shift+I', 'hotkeys.reveal should survive (deep merge)');
  assert.strictEqual(cfg.hotkeys.next, 'Ctrl+Shift+Right', 'hotkeys.next should be set');
  console.log('[test] second save preserves prior nested keys (deep merge) OK');

  console.log('[dev-settings-save-test] PASS');
} finally {
  fs.rmSync(LOCAL_CONFIG_PATH, { force: true });
}
