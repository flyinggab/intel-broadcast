'use strict';

// Verifies the "Record" button UX in the real settings renderer (click ->
// synthetic keydown -> accelerator string captured; click -> Escape ->
// unchanged) by having the app itself run the scripted interaction via
// executeJavaScript (INTEL_BROADCAST_HOTKEY_RECORD_TEST, see index.js) and
// reporting PASS/FAIL over console, which this script greps from stdout.
//
// Usage: node scripts/dev-e2e-hotkey-record-test.js

const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    INTEL_BROADCAST_OPEN_SETTINGS: '1',
    INTEL_BROADCAST_HOTKEY_RECORD_TEST: '1',
    INTEL_BROADCAST_NO_RELAUNCH: '1',
  },
});

let output = '';
function finish(exitCode) {
  child.kill();
  setTimeout(() => process.exit(exitCode), 200);
}

child.stdout.on('data', (d) => {
  const text = d.toString();
  output += text;
  process.stdout.write(`[electron] ${text}`);
  if (text.includes('RECORD_TEST_PASS')) {
    console.log('[e2e] PASS');
    finish(0);
  } else if (text.includes('RECORD_TEST_FAIL')) {
    console.error('[e2e] FAIL (see RECORD_TEST_FAIL line above)');
    finish(1);
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[electron] ${d}`));

setTimeout(() => {
  console.error('[e2e] FAIL: timed out waiting for RECORD_TEST_PASS/FAIL');
  finish(1);
}, 15000);
