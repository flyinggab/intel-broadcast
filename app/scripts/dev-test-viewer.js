'use strict';

// Minimal standalone test client for Phase 0: connects as a viewer, authenticates,
// and on receiving a reveal-batch, verifies every binary frame's sha256 against
// the metadata and writes each image to out/ for manual inspection.
//
// Usage: node scripts/dev-test-viewer.js [ws://localhost:8787] [token]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const url = process.argv[2] || 'ws://localhost:8787';
const token = process.argv[3] || 'dev-secret';
const outDir = path.join(__dirname, '..', 'out');
fs.mkdirSync(outDir, { recursive: true });

const ITEM_ID_LENGTH = 36;

const ws = new WebSocket(url);
let pendingMeta = null;
let received = 0;

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', token, role: 'viewer', callsign: 'dev-test-viewer' }));
  console.log(`[viewer] connected to ${url}, authenticating...`);
});

ws.on('message', (data, isBinary) => {
  if (!isBinary) {
    pendingMeta = JSON.parse(data.toString('utf8'));
    received = 0;
    console.log(`[viewer] reveal-batch ${pendingMeta.batchId}: ${pendingMeta.count} item(s)`);
    for (const item of pendingMeta.items) {
      console.log(`  - ${item.filename} (${item.byteLength} bytes)`);
    }
    return;
  }

  if (!pendingMeta) {
    console.log('[viewer] got binary frame with no pending metadata, ignoring');
    return;
  }

  const itemId = data.subarray(0, ITEM_ID_LENGTH).toString('ascii');
  const bytes = data.subarray(ITEM_ID_LENGTH);
  const item = pendingMeta.items.find((i) => i.itemId === itemId);
  if (!item) {
    console.log(`[viewer] binary frame itemId ${itemId} not found in current batch metadata`);
    return;
  }

  const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const ok = actualSha256 === item.sha256 && bytes.length === item.byteLength;
  const outPath = path.join(outDir, item.filename);
  fs.writeFileSync(outPath, bytes);
  received += 1;
  console.log(`[viewer] wrote ${outPath} — sha256 ${ok ? 'OK' : 'MISMATCH'} (${received}/${pendingMeta.count})`);
});

ws.on('close', (code, reason) => {
  console.log(`[viewer] closed: code=${code} reason=${reason}`);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error(`[viewer] error: ${err.message}`);
});
