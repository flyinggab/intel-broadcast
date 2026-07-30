'use strict';

// Unified-mode share test (no Electron): a real relay server + two real
// RelayClients. Verifies the client-originated reveal path end to end:
//   1. client A shares -> BOTH A (echo) and B receive the batch, bytes
//      intact, sharedBy stamped with A's AUTHENTICATED callsign;
//   2. a client sending immediately on 'connected' (frames chasing the auth
//      frame down the pipe) still gets through — the server's pre-auth queue;
//   3. sharedBy spoofing in the frame itself is overridden by the server;
//   4. an over-cap batch is rejected and reaches nobody.
//
// Usage: node scripts/dev-e2e-share-test.js

const assert = require('assert');
const { createRelayServer } = require('../src/main/relayServer');
const { RelayClient } = require('../src/main/relayClient');
const { buildRevealFrames, MAX_BATCH_ITEMS } = require('../src/main/protocol');

const PORT = 8799;
const TOKEN = 'share-e2e-secret';

const logs = [];
const server = createRelayServer({ port: PORT, token: TOKEN, onLog: (m) => { logs.push(m); console.log(`[relay] ${m}`); } });

function makeClient(callsign) {
  return new RelayClient({ url: `ws://localhost:${PORT}`, token: TOKEN, role: 'viewer', callsign });
}
function makeItems(n, size = 2048) {
  return Array.from({ length: n }, (_, i) => ({
    filename: `${String(i + 1).padStart(2, '0')}-share.jpg`,
    mimeType: 'image/jpeg',
    buffer: Buffer.alloc(size, i + 1),
  }));
}
function nextBatch(client) {
  return new Promise((resolve) => client.once('reveal-batch', resolve));
}
function connected(client) {
  return new Promise((resolve) => client.once('connected', resolve));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const a = makeClient('alpha');
  const b = makeClient('bravo');
  a.connect();
  b.connect();
  await Promise.all([connected(a), connected(b)]);
  await sleep(200); // let auth settle for the normal-path part of the test

  // --- 1. A shares; both A and B receive, sharedBy = alpha ------------------
  const items = makeItems(2);
  const [batchA, batchB] = await Promise.all([
    nextBatch(a),
    nextBatch(b),
    (async () => assert.ok(a.sendRevealBatch(items), 'send returns a batchId'))(),
  ]);
  for (const [who, batch] of [['A(echo)', batchA], ['B', batchB]]) {
    assert.strictEqual(batch.items.length, 2, `${who} item count`);
    assert.strictEqual(batch.sharedBy, 'alpha', `${who} sharedBy`);
    assert.ok(batch.items[0].buffer.equals(items[0].buffer), `${who} bytes intact`);
  }
  console.log('[e2e] 1. share fan-out with echo + sharedBy OK');

  // --- 2. burst: share in the same tick as 'connected' ----------------------
  const c = makeClient('charlie');
  const got = nextBatch(b);
  c.on('connected', () => {
    assert.ok(c.sendRevealBatch(makeItems(1, 512)), 'burst send accepted locally');
  });
  c.connect();
  const burst = await got;
  assert.strictEqual(burst.sharedBy, 'charlie', 'burst batch attributed correctly');
  assert.strictEqual(burst.items.length, 1);
  console.log('[e2e] 2. immediate-send-after-connect (pre-auth queue) OK');

  // --- 3. sharedBy spoofing is overridden by the server ---------------------
  const spoofGot = nextBatch(b);
  const spoofed = buildRevealFrames(makeItems(1, 256), { sharedBy: 'the-impostor' });
  a.ws.send(spoofed.metaFrame);
  for (const f of spoofed.binaryFrames) a.ws.send(f, { binary: true });
  const spoofBatch = await spoofGot;
  assert.strictEqual(spoofBatch.sharedBy, 'alpha', 'server stamps the authenticated callsign');
  console.log('[e2e] 3. sharedBy spoof override OK');

  // --- 4. over-cap batch rejected, delivered to nobody ----------------------
  let leaked = false;
  const leakWatch = (batch) => { if (batch.items.length > MAX_BATCH_ITEMS) leaked = true; };
  b.on('reveal-batch', leakWatch);
  const tooMany = buildRevealFrames(makeItems(MAX_BATCH_ITEMS + 1, 10));
  a.ws.send(tooMany.metaFrame);
  for (const f of tooMany.binaryFrames) a.ws.send(f, { binary: true });
  await sleep(400);
  assert.ok(logs.some((m) => m.includes('rejected batch from alpha')), 'server logged the rejection');
  assert.ok(!leaked, 'over-cap batch never fanned out');
  console.log('[e2e] 4. cap rejection OK');

  a.close();
  b.close();
  c.close();
  server.close();
  console.log('[dev-e2e-share-test] PASS');
  process.exit(0);
}

main().catch((err) => {
  console.error(`[e2e] FAIL: ${err.message}`);
  process.exit(1);
});

setTimeout(() => {
  console.error('[e2e] FAIL: timeout');
  process.exit(1);
}, 15000);
