'use strict';

// Unified-mode smoke test (was dev-e2e-gm-test.js): spawns a real HOST
// instance (runs the embedded relay; its own client connects to localhost)
// and a real plain instance as separate, concurrent processes (each with its
// own isolated config via INTEL_BROADCAST_LOCAL_CONFIG_PATH), then triggers a
// reveal FROM THE NON-HOST INSTANCE — the defining property of unified mode:
// any client can share, the hub fans it out. The host's own marker file must
// show the batch, attributed to the sharer's callsign.
//
// Usage: node scripts/dev-e2e-host-test.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');

const APP_DIR = path.join(__dirname, '..');
const HOST_CONFIG_PATH = path.join(APP_DIR, 'host-e2e-config.local.json');
const SHARER_CONFIG_PATH = path.join(APP_DIR, 'sharer-e2e-config.local.json');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const MARKER_PATH = path.join(APP_DIR, 'host-received-marker.json');

const RELAY_PORT = require('./dev-ports').host;
const TOKEN = 'host-e2e-secret';
const TRIGGER_PORT = require('./dev-ports').hostTrigger;
const MISSION_NAME = 'roman-sead-joker1';

fs.rmSync(MARKER_PATH, { force: true });

fs.writeFileSync(
  HOST_CONFIG_PATH,
  JSON.stringify(
    { relayHostEnabled: true, token: TOKEN, callsign: 'host-1', missionName: MISSION_NAME, gm: { relayPort: RELAY_PORT } },
    null,
    2,
  ),
);
fs.writeFileSync(
  SHARER_CONFIG_PATH,
  JSON.stringify(
    { relayUrl: `ws://localhost:${RELAY_PORT}`, token: TOKEN, callsign: 'sharer-1', missionName: MISSION_NAME },
    null,
    2,
  ),
);

// The HOST carries the received-marker hook: it must get the batch even
// though someone else shared it.
const hostChild = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
    detached: true, // process GROUP, so killTree reaches the real binary
  env: {
    ...process.env,
    INTEL_BROADCAST_LOCAL_CONFIG_PATH: HOST_CONFIG_PATH,
    INTEL_BROADCAST_RECEIVED_MARKER_PATH: MARKER_PATH,
  },
});
hostChild.stdout.on('data', (d) => process.stdout.write(`[host] ${d}`));
hostChild.stderr.on('data', (d) => process.stderr.write(`[host] ${d}`));

let sharerChild;

function cleanup(exitCode) {
  fs.rmSync(HOST_CONFIG_PATH, { force: true });
  fs.rmSync(SHARER_CONFIG_PATH, { force: true });
  fs.rmSync(MARKER_PATH, { force: true });
  killApp(hostChild);
  if (sharerChild) killApp(sharerChild);
  setTimeout(() => process.exit(exitCode), 200);
}

// Give the host time to boot its window + embedded relay, then launch the
// sharer instance (own isolated config, concurrent process) pointed at it —
// the SHARER carries the reveal trigger endpoint.
setTimeout(() => {
  sharerChild = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
    cwd: APP_DIR,
    detached: true, // process GROUP, so killTree reaches the real binary
    env: {
      ...process.env,
      INTEL_BROADCAST_LOCAL_CONFIG_PATH: SHARER_CONFIG_PATH,
      INTEL_BROADCAST_TEST_TRIGGER_PORT: String(TRIGGER_PORT),
    },
  });
  sharerChild.stdout.on('data', (d) => process.stdout.write(`[sharer] ${d}`));
  sharerChild.stderr.on('data', (d) => process.stderr.write(`[sharer] ${d}`));

  // Give the sharer time to connect + auth, then fire ITS trigger (stands in
  // for the sharer pressing the reveal hotkey on their machine).
  setTimeout(() => {
    http.get(`http://127.0.0.1:${TRIGGER_PORT}`, () => {
      console.log('[e2e] hit the SHARER instance trigger endpoint');
    });
  }, 2500);
}, 2000);

// Poll for the host's marker file (written when it receives a reveal-batch).
const deadline = Date.now() + 15000;
const poll = setInterval(() => {
  if (fs.existsSync(MARKER_PATH)) {
    clearInterval(poll);
    const marker = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf8'));
    console.log(`[e2e] host received batch: ${JSON.stringify(marker)}`);
    const ok = marker.filenames.length === 2 && marker.sharedBy === 'sharer-1';
    console.log(
      ok
        ? '[e2e] PASS: a non-host client shared, the host received the fan-out with correct attribution'
        : `[e2e] FAIL: expected 2 files shared by "sharer-1", got ${marker.filenames.length} shared by "${marker.sharedBy}"`,
    );
    cleanup(ok ? 0 : 1);
  } else if (Date.now() > deadline) {
    clearInterval(poll);
    console.error('[e2e] FAIL: timed out waiting for the host to receive the batch');
    cleanup(1);
  }
}, 300);
