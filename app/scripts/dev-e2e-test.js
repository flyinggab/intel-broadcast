'use strict';

// Self-contained Phase 0 smoke test: starts the relay server, connects a viewer
// client, waits for it to auth, triggers one reveal-batch broadcast from a
// photo folder, and verifies the viewer received every item intact.
//
// Usage: node scripts/dev-e2e-test.js <photo-folder>

const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { createRelayServer, readPhotoFolder } = require('../src/main/relayServer');

const folderPath = process.argv[2];
if (!folderPath) {
  console.error('usage: node scripts/dev-e2e-test.js <photo-folder>');
  process.exit(1);
}

const PORT = 8788;
const TOKEN = 'e2e-test-secret';
const ITEM_ID_LENGTH = 36;

const server = createRelayServer({ port: PORT, token: TOKEN, onLog: (m) => console.log(`[relay] ${m}`) });

const ws = new WebSocket(`ws://localhost:${PORT}`);
let pendingMeta = null;
let receivedCount = 0;
let mismatches = 0;

function finish(exitCode) {
  server.close();
  ws.close();
  setTimeout(() => process.exit(exitCode), 100);
}

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', token: TOKEN, role: 'viewer', callsign: 'e2e-test' }));
});

ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    pendingMeta = JSON.parse(data.toString('utf8'));
    console.log(`[viewer] reveal-batch received: ${pendingMeta.count} item(s)`);
    return;
  }

  const itemId = data.subarray(0, ITEM_ID_LENGTH).toString('ascii');
  const bytes = data.subarray(ITEM_ID_LENGTH);
  const item = pendingMeta.items.find((i) => i.itemId === itemId);
  if (!item) {
    console.log(`[viewer] FAIL: unknown itemId ${itemId}`);
    mismatches += 1;
  } else {
    const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const ok = actualSha256 === item.sha256 && bytes.length === item.byteLength;
    console.log(`[viewer] ${ok ? 'OK' : 'FAIL'} ${item.filename} (${bytes.length} bytes)`);
    if (!ok) mismatches += 1;
  }

  receivedCount += 1;
  if (pendingMeta && receivedCount === pendingMeta.count) {
    console.log(mismatches === 0 ? '[e2e] PASS' : `[e2e] FAIL: ${mismatches} mismatch(es)`);
    finish(mismatches === 0 ? 0 : 1);
  }
});

// Give the client ~500ms to finish the WS handshake + auth before broadcasting.
setTimeout(() => {
  const items = readPhotoFolder(path.resolve(folderPath));
  if (items.length === 0) {
    console.error(`[e2e] FAIL: no photos found in ${folderPath}`);
    finish(1);
    return;
  }
  console.log(`[e2e] broadcasting ${items.length} item(s) from ${folderPath}`);
  server.broadcastRevealBatch(items);
}, 500);

setTimeout(() => {
  console.error('[e2e] FAIL: timed out waiting for full batch');
  finish(1);
}, 5000);
