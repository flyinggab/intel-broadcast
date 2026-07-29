'use strict';

// Phase 2 smoke test: spawns a real GM-mode instance and a real plain viewer
// instance as separate, concurrent processes (each with its own isolated
// config.local.json via INTEL_BROADCAST_LOCAL_CONFIG_PATH, mirroring the real
// two-terminal local testing setup), points the viewer at the GM's embedded
// relay, hits the GM's dev-only test-trigger endpoint (stands in for a real
// hotkey press), and confirms the viewer actually received the batch via its
// dev-only marker file.
//
// Usage: node scripts/dev-e2e-gm-test.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const GM_CONFIG_PATH = path.join(APP_DIR, 'gm-e2e-config.local.json');
const VIEWER_CONFIG_PATH = path.join(APP_DIR, 'viewer-e2e-config.local.json');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const MARKER_PATH = path.join(APP_DIR, 'out-marker.json');

const RELAY_PORT = 8795;
const TOKEN = 'gm-e2e-secret';
const TRIGGER_PORT = 8796;
const MISSION_NAME = 'roman-sead-joker1';

fs.rmSync(MARKER_PATH, { force: true });

fs.writeFileSync(
  GM_CONFIG_PATH,
  JSON.stringify({ gmModeEnabled: true, token: TOKEN, missionName: MISSION_NAME, gm: { relayPort: RELAY_PORT } }, null, 2),
);
fs.writeFileSync(
  VIEWER_CONFIG_PATH,
  JSON.stringify({ relayUrl: `ws://localhost:${RELAY_PORT}`, token: TOKEN, callsign: 'gm-e2e-viewer' }, null, 2),
);

const gmChild = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    INTEL_BROADCAST_LOCAL_CONFIG_PATH: GM_CONFIG_PATH,
    INTEL_BROADCAST_TEST_TRIGGER_PORT: String(TRIGGER_PORT),
  },
});
gmChild.stdout.on('data', (d) => process.stdout.write(`[gm] ${d}`));
gmChild.stderr.on('data', (d) => process.stderr.write(`[gm] ${d}`));

let viewerChild;

function cleanup(exitCode) {
  fs.rmSync(GM_CONFIG_PATH, { force: true });
  fs.rmSync(VIEWER_CONFIG_PATH, { force: true });
  fs.rmSync(MARKER_PATH, { force: true });
  gmChild.kill();
  if (viewerChild) viewerChild.kill();
  setTimeout(() => process.exit(exitCode), 200);
}

// Give the GM instance time to boot its window + embedded relay server, then
// launch a plain viewer instance (its own isolated config, running
// concurrently — not sequential writes to a shared file) pointed at it.
setTimeout(() => {
  viewerChild = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      INTEL_BROADCAST_LOCAL_CONFIG_PATH: VIEWER_CONFIG_PATH,
      INTEL_BROADCAST_RECEIVED_MARKER_PATH: MARKER_PATH,
    },
  });
  viewerChild.stdout.on('data', (d) => process.stdout.write(`[viewer] ${d}`));
  viewerChild.stderr.on('data', (d) => process.stderr.write(`[viewer] ${d}`));

  // Give the viewer time to connect + auth, then fire the GM's test trigger
  // (stands in for a real Ctrl+Shift+I press).
  setTimeout(() => {
    http.get(`http://127.0.0.1:${TRIGGER_PORT}`, () => {
      console.log('[e2e] hit GM test-trigger endpoint');
    });
  }, 2000);
}, 2000);

// Poll for the viewer's marker file (written when it receives a reveal-batch).
const deadline = Date.now() + 12000;
const poll = setInterval(() => {
  if (fs.existsSync(MARKER_PATH)) {
    clearInterval(poll);
    const marker = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8'));
    console.log(`[e2e] viewer received batch: ${JSON.stringify(marker)}`);
    console.log(marker.filenames.length === 2 ? '[e2e] PASS' : '[e2e] FAIL: unexpected item count');
    cleanup(marker.filenames.length === 2 ? 0 : 1);
  } else if (Date.now() > deadline) {
    clearInterval(poll);
    console.error('[e2e] FAIL: timed out waiting for viewer to receive batch');
    cleanup(1);
  }
}, 300);
