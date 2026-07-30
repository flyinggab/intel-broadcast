'use strict';

// Replaces dev-e2e-relaunch-test.js: settings saves now apply LIVE in the
// same process instead of via app.relaunch(). Drives a real save through the
// actual settings-window IPC path on a running GM instance and verifies, all
// without the process restarting:
//   1. the reveal hotkey re-registers to the newly saved accelerator
//      (marker file rewritten by the same, still-alive process);
//   2. the embedded relay actually restarts on the NEW port with the NEW
//      token — proven by a real ws client (the app's own RelayClient)
//      connecting there and receiving a broadcast triggered via the dev
//      trigger endpoint.
//
// Usage: node scripts/dev-e2e-live-apply-test.js

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { RelayClient } = require('../src/main/relayClient');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const CONFIG_PATH = path.join(APP_DIR, 'live-apply-config.local.json');
const MARKER_PATH = path.join(APP_DIR, 'live-apply-marker.json');

const OLD_PORT = 8791;
const NEW_PORT = 8792;
const TRIGGER_PORT = 8793;
const NEW_TOKEN = 'live-apply-token-2';

const SAVE_PAYLOAD = {
  relayHostEnabled: true,
  token: NEW_TOKEN,
  gm: { relayPort: NEW_PORT },
  hotkeys: { reveal: 'Ctrl+Shift+U' },
};

fs.rmSync(MARKER_PATH, { force: true });
// Boot as host on the OLD port/token with the default reveal hotkey; the save
// then moves all three live. missionName keeps the bundled 2-photo fixture as
// the reveal source (photosFolder is never set).
fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify(
    {
      relayHostEnabled: true,
      token: 'live-apply-token-1',
      callsign: 'live-host',
      missionName: 'roman-sead-joker1',
      gm: { relayPort: OLD_PORT },
    },
    null,
    2,
  ),
);

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    INTEL_BROADCAST_LOCAL_CONFIG_PATH: CONFIG_PATH,
    INTEL_BROADCAST_HOTKEY_REGISTER_MARKER_PATH: MARKER_PATH,
    INTEL_BROADCAST_TEST_TRIGGER_PORT: String(TRIGGER_PORT),
    INTEL_BROADCAST_OPEN_SETTINGS: '1',
    INTEL_BROADCAST_SETTINGS_AUTOSAVE_JSON: JSON.stringify(SAVE_PAYLOAD),
  },
});
child.stdout.on('data', (d) => process.stdout.write(`[app] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

let relayProbe = null;

function cleanup(exitCode) {
  fs.rmSync(CONFIG_PATH, { force: true });
  fs.rmSync(MARKER_PATH, { force: true });
  if (triggerTimer) clearInterval(triggerTimer);
  if (relayProbe) relayProbe.close();
  child.kill();
  // Safety sweep: if a regression brought app.relaunch() back, its child is
  // not ours and would leak past child.kill(). (ps shows the real binary under
  // node_modules/electron/dist, not the .bin symlink.)
  try {
    execSync(`pkill -9 -f "${APP_DIR}/node_modules/electron/dist/electron"`);
  } catch {
    // pkill exits non-zero when nothing matched — fine
  }
  setTimeout(() => process.exit(exitCode), 300);
}

child.on('exit', (code) => {
  console.error(`[e2e] FAIL: app exited (code ${code}) — a save must apply live, not restart`);
  cleanup(1);
});
function pass() {
  child.removeAllListeners('exit');
  console.log('[e2e] PASS: same process re-registered the new hotkey AND restarted the relay on the new port/token');
  cleanup(0);
}
function fail(msg) {
  child.removeAllListeners('exit');
  console.error(`[e2e] FAIL: ${msg}`);
  cleanup(1);
}

// Step 2 (runs after the marker confirms the live hotkey swap): connect to the
// NEW port with the NEW token — RelayClient's own retry/backoff absorbs the
// small window while the relay finishes restarting. The reveal now flows
// through the app's OWN relay client (unified mode), which also has to finish
// reconnecting to the new port — so keep re-firing the trigger until a batch
// arrives instead of betting on one lucky shot.
let triggerTimer = null;
function verifyRelayRestarted() {
  relayProbe = new RelayClient({
    url: `ws://localhost:${NEW_PORT}`,
    token: NEW_TOKEN,
    role: 'viewer',
    callsign: 'live-apply-probe',
  });
  relayProbe.on('connected', () => {
    console.log('[e2e] probe connected to relay on NEW port with NEW token');
    triggerTimer = setInterval(() => {
      require('http').get(`http://127.0.0.1:${TRIGGER_PORT}`, () => console.log('[e2e] hit trigger endpoint'));
    }, 1000);
  });
  relayProbe.on('reveal-batch', (batch) => {
    clearInterval(triggerTimer);
    if (batch.items.length === 2 && batch.sharedBy === 'live-host') pass();
    else fail(`expected the 2-photo fixture batch shared by "live-host", got ${batch.items.length} item(s) from "${batch.sharedBy}"`);
  });
  relayProbe.connect();
}

// Step 1: watch the marker. The process writes it at startup with the default
// hotkey (Ctrl+Shift+I), then must REWRITE it with the saved custom value —
// same PID, no relaunch (any exit fails the test via the handler above).
let sawLiveSwap = false;
let lastSeen = null;
const deadline = Date.now() + 25000;
const poll = setInterval(() => {
  if (Date.now() > deadline) {
    clearInterval(poll);
    fail(`timed out — last marker: ${JSON.stringify(lastSeen)}, relay verified: false`);
    return;
  }
  if (!fs.existsSync(MARKER_PATH)) return;
  const marker = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8'));
  if (JSON.stringify(marker) !== JSON.stringify(lastSeen)) {
    console.log(`[e2e] marker update: ${JSON.stringify(marker)}`);
    lastSeen = marker;
  }
  if (!sawLiveSwap && marker.reveal === 'Ctrl+Shift+U' && marker.revealRegistered === true) {
    sawLiveSwap = true;
    clearInterval(poll);
    console.log('[e2e] live hotkey swap confirmed — now verifying the relay restarted');
    verifyRelayRestarted();
  }
}, 300);
