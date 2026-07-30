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
const { killApp } = require('./dev-electron');
const { RelayClient } = require('../src/main/relayClient');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const CONFIG_PATH = path.join(APP_DIR, 'clients-list-config.local.json');

const RELAY_PORT = require('./dev-ports').clientsList;
const TOKEN = 'clients-list-secret';
const CALLSIGN = 'Ghostrider-1';

fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify({ relayHostEnabled: true, token: TOKEN, callsign: 'host-self', gm: { relayPort: RELAY_PORT } }, null, 2),
);

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
    detached: true, // process GROUP, so killTree reaches the real binary
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
  killApp(child);
  setTimeout(() => process.exit(exitCode), 200);
}

// Stages: 0 = waiting for the DOM to show the host's OWN client (in unified
// mode the host's app connects to its own relay, so it appears in its own
// list), 1 = external client connected, waiting for its callsign to show up
// alongside, 2 = client closed, waiting for its callsign to disappear while
// the host's own entry remains.
let stage = 0;
child.stdout.on('data', (d) => {
  const text = d.toString();
  process.stdout.write(`[app] ${text}`);
  for (const line of text.split('\n')) {
    if (!line.includes('CLIENTS_PROBE')) continue;
    if (stage === 0 && line.includes('host-self')) {
      stage = 1;
      console.log('[e2e] host sees itself in its own client list — connecting an external client');
      probeClient = new RelayClient({
        url: `ws://localhost:${RELAY_PORT}`,
        token: TOKEN,
        role: 'viewer',
        callsign: CALLSIGN,
      });
      probeClient.connect();
    } else if (stage === 1 && line.includes(CALLSIGN) && line.includes('host-self')) {
      stage = 2;
      console.log('[e2e] external callsign appeared in the settings DOM — disconnecting it');
      probeClient.close();
    } else if (stage === 2 && !line.includes(CALLSIGN) && line.includes('host-self')) {
      console.log('[e2e] PASS: live list showed host-self + external client, and removed the client on disconnect');
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
