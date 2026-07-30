'use strict';

// Phase 0 smoke test: a client with the wrong token must be rejected with 4001.
const WebSocket = require('ws');
const { createRelayServer } = require('../src/main/relayServer');

const PORT = require('./dev-ports').auth;
const server = createRelayServer({ port: PORT, token: 'correct-secret', onLog: (m) => console.log(`[relay] ${m}`) });

const ws = new WebSocket(`ws://localhost:${PORT}`);
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', token: 'wrong-secret', role: 'viewer', callsign: 'bad-actor' }));
});
ws.on('close', (code) => {
  console.log(code === 4001 ? '[auth-test] PASS (closed 4001 as expected)' : `[auth-test] FAIL (closed ${code})`);
  server.close();
  setTimeout(() => process.exit(code === 4001 ? 0 : 1), 100);
});
ws.on('error', () => {});

setTimeout(() => {
  console.error('[auth-test] FAIL: timed out');
  process.exit(1);
}, 3000);
