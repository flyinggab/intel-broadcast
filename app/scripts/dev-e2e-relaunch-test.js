'use strict';

// The real end-to-end scenario the bug report described: save a custom
// hotkey through the actual settings UI (with app.relaunch() actually
// enabled, not suppressed), and confirm the RELAUNCHED process registers the
// new custom value. Marker files (not stdout, since app.relaunch()'s child
// may not inherit our piped stdio) are how both the original and relaunched
// process report what they did.
//
// Usage: node scripts/dev-e2e-relaunch-test.js

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { LOCAL_CONFIG_PATH } = require('../src/main/config');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const MARKER_PATH = path.join(APP_DIR, 'relaunch-test-marker.json');

const SAVE_PAYLOAD = {
  token: 'relaunch-test',
  gm: { relayPort: 8798 },
  hotkeys: { reveal: 'Ctrl+Shift+U', next: 'Ctrl+Shift+Right', prev: 'Ctrl+Shift+Left', settings: 'Ctrl+Shift+O' },
};

fs.rmSync(LOCAL_CONFIG_PATH, { force: true });
fs.rmSync(MARKER_PATH, { force: true });

const child = spawn(ELECTRON_BIN, ['.', '--gm', '--no-sandbox'], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    INTEL_BROADCAST_OPEN_SETTINGS: '1',
    INTEL_BROADCAST_SETTINGS_AUTOSAVE_JSON: JSON.stringify(SAVE_PAYLOAD),
    INTEL_BROADCAST_HOTKEY_REGISTER_MARKER_PATH: MARKER_PATH,
    // relaunch is NOT suppressed this time — that's the whole point of this test
  },
});
child.stdout.on('data', (d) => process.stdout.write(`[gen1] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[gen1] ${d}`));

function cleanup(exitCode) {
  fs.rmSync(LOCAL_CONFIG_PATH, { force: true });
  fs.rmSync(MARKER_PATH, { force: true });
  child.kill();
  // app.relaunch()'s generation-2 process is spawned by Electron internally,
  // not as a direct child of `child` above — child.kill() doesn't reach it,
  // so it'd otherwise leak. Sweep by command-line pattern instead.
  try {
    execSync(`pkill -9 -f "${ELECTRON_BIN}.*--gm"`);
  } catch {
    // pkill exits non-zero when nothing matched — fine, nothing to clean up
  }
  setTimeout(() => process.exit(exitCode), 300);
}

// Generation 1 writes this marker too, at its own normal startup, with the
// still-default hotkey — before the autosave/relaunch has even happened. Keep
// polling past that premature marker; only generation 2 (post-relaunch)
// should ever report the NEW custom value.
let lastSeen = null;
const deadline = Date.now() + 20000;
const poll = setInterval(() => {
  if (fs.existsSync(MARKER_PATH)) {
    const marker = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8'));
    if (JSON.stringify(marker) !== JSON.stringify(lastSeen)) {
      console.log(`[e2e] marker update: ${JSON.stringify(marker)}`);
      lastSeen = marker;
    }
    if (marker.reveal === 'Ctrl+Shift+U') {
      clearInterval(poll);
      const ok = marker.revealRegistered === true;
      console.log(ok ? '[e2e] PASS: the RELAUNCHED process registered the new custom reveal hotkey' : '[e2e] FAIL: new value present but not registered');
      cleanup(ok ? 0 : 1);
      return;
    }
  }
  if (Date.now() > deadline) {
    clearInterval(poll);
    console.error(`[e2e] FAIL: timed out — never saw the relaunched process's marker. Last seen: ${JSON.stringify(lastSeen)}`);
    cleanup(1);
  }
}, 300);
