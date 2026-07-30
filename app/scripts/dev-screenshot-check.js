'use strict';

// One-off visual verification: same shape as dev-e2e-electron-test.js, but
// asks the app to capture a screenshot of the rendered batch via
// INTEL_BROADCAST_SCREENSHOT_PATH instead of just checking it stayed alive.
//
// Usage: node scripts/dev-screenshot-check.js <photo-folder> <output-png>

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createRelayServer, readPhotoFolder } = require('../src/main/relayServer');

const folderPath = process.argv[2];
const outputPng = process.argv[3];
if (!folderPath || !outputPng) {
  console.error('usage: node scripts/dev-screenshot-check.js <photo-folder> <output-png>');
  process.exit(1);
}

const APP_DIR = path.join(__dirname, '..');
const LOCAL_CONFIG_PATH = path.join(APP_DIR, 'resources', 'config.local.json');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');

const PORT = require('./dev-ports').screenshotCheck;
const TOKEN = 'screenshot-check-secret';

let connectedClients = 0;
const server = createRelayServer({
  port: PORT,
  token: TOKEN,
  onLog: (msg) => {
    console.log(`[relay] ${msg}`);
    if (msg.startsWith('client connected')) connectedClients += 1;
  },
});

fs.writeFileSync(
  LOCAL_CONFIG_PATH,
  JSON.stringify({ relayUrl: `ws://localhost:${PORT}`, token: TOKEN, callsign: 'screenshot-check' }, null, 2),
);

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
  env: { ...process.env, INTEL_BROADCAST_SCREENSHOT_PATH: path.resolve(outputPng) },
});
child.stdout.on('data', (d) => process.stdout.write(`[electron] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[electron] ${d}`));

function cleanup(exitCode) {
  fs.rmSync(LOCAL_CONFIG_PATH, { force: true });
  server.close();
  child.kill();
  setTimeout(() => process.exit(exitCode), 200);
}

setTimeout(() => {
  if (connectedClients === 0) {
    console.error('[screenshot-check] FAIL: app never connected');
    cleanup(1);
    return;
  }
  const items = readPhotoFolder(path.resolve(folderPath));
  server.broadcastRevealBatch(items);
  // The app's screenshot hook quits itself once it's written the file — wait
  // for that natural exit instead of racing a fixed timer against a kill().
}, 3000);

child.on('exit', () => {
  fs.rmSync(LOCAL_CONFIG_PATH, { force: true });
  server.close();
  if (fs.existsSync(outputPng)) {
    console.log(`[screenshot-check] PASS: wrote ${outputPng}`);
    process.exit(0);
  } else {
    console.error('[screenshot-check] FAIL: no screenshot written');
    process.exit(1);
  }
});

setTimeout(() => {
  console.error('[screenshot-check] FAIL: overall timeout');
  cleanup(1);
}, 15000);
