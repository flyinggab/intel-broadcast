'use strict';

// Phase 1 smoke test: starts a relay, points the real Electron app at it via a
// temporary config.local.json, waits for the app to connect, triggers a
// reveal-batch, and checks the app process stayed alive with no uncaught
// exceptions on stderr. Doesn't verify pixels (that needs eyes on a real
// screen / the Windows host) — just that the whole pipe doesn't throw.
//
// Usage: node scripts/dev-e2e-electron-test.js <photo-folder>

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');
const { createRelayServer, readPhotoFolder } = require('../src/main/relayServer');

const folderPath = process.argv[2];
if (!folderPath) {
  console.error('usage: node scripts/dev-e2e-electron-test.js <photo-folder>');
  process.exit(1);
}

const APP_DIR = path.join(__dirname, '..');
const LOCAL_CONFIG_PATH = path.join(APP_DIR, 'resources', 'config.local.json');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');

const PORT = require('./dev-ports').electronE2E;
const TOKEN = 'electron-e2e-secret';

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
  JSON.stringify({ relayUrl: `ws://localhost:${PORT}`, token: TOKEN, callsign: 'e2e-electron-test' }, null, 2),
);

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
  detached: true, // process GROUP, so killApp reaches the real binary
});
let stderr = '';
child.stdout.on('data', (d) => process.stdout.write(`[electron] ${d}`));
child.stderr.on('data', (d) => {
  stderr += d.toString();
  process.stderr.write(`[electron] ${d}`);
});

function cleanup(exitCode) {
  fs.rmSync(LOCAL_CONFIG_PATH, { force: true });
  server.close();
  killApp(child);
  setTimeout(() => process.exit(exitCode), 200);
}

// Give Electron time to boot + connect, then broadcast.
setTimeout(() => {
  if (connectedClients === 0) {
    console.error('[e2e] FAIL: Electron app never connected to the relay');
    cleanup(1);
    return;
  }

  const items = readPhotoFolder(path.resolve(folderPath));
  console.log(`[e2e] broadcasting ${items.length} item(s) from ${folderPath}`);
  server.broadcastRevealBatch(items);

  setTimeout(() => {
    const stillAlive = child.exitCode === null;
    const hasFatalError = /Uncaught|TypeError|ReferenceError/.test(stderr);
    if (stillAlive && !hasFatalError) {
      console.log('[e2e] PASS: Electron app connected, received batch, stayed alive with no uncaught errors');
      cleanup(0);
    } else {
      console.error(`[e2e] FAIL: alive=${stillAlive} hasFatalError=${hasFatalError}`);
      cleanup(1);
    }
  }, 2000);
}, 3000);

setTimeout(() => {
  console.error('[e2e] FAIL: overall timeout');
  cleanup(1);
}, 15000);
