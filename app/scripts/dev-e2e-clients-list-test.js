'use strict';

// Verifies the GM settings window's "Connected clients" section updates live:
// spawns a GM instance with the settings window auto-opened and a DOM probe
// (INTEL_BROADCAST_CLIENTS_PROBE periodically prints the section's rendered
// text), connects a real relay client with a callsign, and checks the
// callsign appears in the settings DOM — then disconnects and checks it
// leaves again. Exercises the full path: ws auth -> relayServer client map ->
// pushConnectedClients -> IPC -> renderer.
//
// Usage: node scripts/dev-e2e-clients-list-test.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { RelayClient } = require('../src/main/relayClient');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const CONFIG_PATH = path.join(APP_DIR, 'clients-list-config.local.json');

const RELAY_PORT = 8794;
const TOKEN = 'clients-list-secret';
const CALLSIGN = 'Ghostrider-1';

fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify({ gmModeEnabled: true, token: TOKEN, gm: { relayPort: RELAY_PORT } }, null, 2),
);

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    INTEL_BROADCAST_LOCAL_CONFIG_PATH: CONFIG_PATH,
    INTEL_BROADCAST_OPEN_SETTINGS: '1',
    INTEL_BROADCAST_CLIENTS_PROBE: '1',
  },
});

let probeClient = null;

function cleanup(exitCode) {
  fs.rmSync(CONFIG_PATH, { force: true });
  if (probeClient) probeClient.close();
  child.kill();
  setTimeout(() => process.exit(exitCode), 200);
}

// Stages: 0 = waiting for the settings DOM probe to report at all (empty
// list), 1 = client connected, waiting for its callsign to show up, 2 =
// client closed, waiting for the callsign to disappear again.
let stage = 0;
child.stdout.on('data', (d) => {
  const text = d.toString();
  process.stdout.write(`[app] ${text}`);
  for (const line of text.split('\n')) {
    if (!line.includes('CLIENTS_PROBE')) continue;
    if (stage === 0) {
      stage = 1;
      console.log('[e2e] settings DOM probe is live — connecting a client');
      probeClient = new RelayClient({
        url: `ws://localhost:${RELAY_PORT}`,
        token: TOKEN,
        role: 'viewer',
        callsign: CALLSIGN,
      });
      probeClient.connect();
    } else if (stage === 1 && line.includes(CALLSIGN)) {
      stage = 2;
      console.log('[e2e] callsign appeared in the settings DOM — disconnecting the client');
      probeClient.close();
    } else if (stage === 2 && !line.includes(CALLSIGN)) {
      console.log('[e2e] PASS: connected client (with username) shown live in Settings, and removed on disconnect');
      cleanup(0);
      return;
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

setTimeout(() => {
  console.error(`[e2e] FAIL: timed out at stage ${stage} (0=no probe output, 1=callsign never appeared, 2=never removed)`);
  cleanup(1);
}, 25000);
