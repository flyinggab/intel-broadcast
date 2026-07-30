'use strict';

// Unit test for protocol.js — the shared reveal-batch framing/reassembly used
// by both the relay server (client-originated batches) and the relay client
// (received fan-outs). Pure Node.
//
// Usage: node scripts/dev-protocol-test.js

const assert = require('assert');
const { buildRevealFrames, BatchReassembler, MAX_BATCH_ITEMS } = require('../src/main/protocol');

function makeItems(n, size = 1000) {
  return Array.from({ length: n }, (_, i) => ({
    filename: `${String(i + 1).padStart(2, '0')}-photo.jpg`,
    mimeType: 'image/jpeg',
    buffer: Buffer.alloc(size, i + 1),
  }));
}

// --- Round trip: build -> feed -> identical batch ---------------------------
{
  const items = makeItems(3);
  const { batchId, metaFrame, binaryFrames } = buildRevealFrames(items, { sharedBy: 'Ghostrider-1' });
  const r = new BatchReassembler();

  assert.strictEqual(r.feed(Buffer.from(metaFrame), false), null, 'meta alone completes nothing');
  assert.strictEqual(r.feed(binaryFrames[0], true), null);
  assert.strictEqual(r.feed(binaryFrames[1], true), null);
  const batch = r.feed(binaryFrames[2], true);
  assert.ok(batch, 'last frame completes the batch');
  assert.strictEqual(batch.batchId, batchId);
  assert.strictEqual(batch.sharedBy, 'Ghostrider-1');
  assert.strictEqual(batch.items.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(batch.items[i].filename, items[i].filename);
    assert.ok(batch.items[i].buffer.equals(items[i].buffer), `item ${i} bytes intact`);
  }
  console.log('[test] round trip OK');
}

// --- Out-of-order binary frames still assemble correctly --------------------
{
  const items = makeItems(2);
  const { metaFrame, binaryFrames } = buildRevealFrames(items);
  const r = new BatchReassembler();
  r.feed(Buffer.from(metaFrame), false);
  r.feed(binaryFrames[1], true);
  const batch = r.feed(binaryFrames[0], true);
  assert.ok(batch);
  assert.ok(batch.items[0].buffer.equals(items[0].buffer), 'metadata order preserved despite arrival order');
  console.log('[test] out-of-order frames OK');
}

// --- Stray frames are ignored, new meta replaces a half-built batch ---------
{
  const r = new BatchReassembler();
  assert.strictEqual(r.feed(Buffer.alloc(50, 7), true), null, 'binary with no batch in flight ignored');
  assert.strictEqual(r.feed(Buffer.from('{"type":"something-else"}'), false), null);
  assert.strictEqual(r.feed(Buffer.from('not json at all'), false), null);

  const a = buildRevealFrames(makeItems(2));
  const b = buildRevealFrames(makeItems(1, 500));
  r.feed(Buffer.from(a.metaFrame), false);
  r.feed(a.binaryFrames[0], true); // batch A half done
  r.feed(Buffer.from(b.metaFrame), false); // batch B replaces it
  assert.strictEqual(r.feed(a.binaryFrames[1], true), null, 'stale batch-A frame no longer expected');
  const batch = r.feed(b.binaryFrames[0], true);
  assert.strictEqual(batch.batchId, b.batchId, 'batch B completes cleanly');
  console.log('[test] stray/replacement handling OK');
}

// --- Caps: item count and total bytes ---------------------------------------
{
  const r = new BatchReassembler({ maxItems: 3, maxTotalBytes: 5000 });

  const tooMany = buildRevealFrames(makeItems(4, 10));
  assert.throws(() => r.feed(Buffer.from(tooMany.metaFrame), false), /exceeds cap/, 'item cap enforced');

  const tooBig = buildRevealFrames(makeItems(2, 3000));
  assert.throws(() => r.feed(Buffer.from(tooBig.metaFrame), false), /exceeds cap/, 'declared byte cap enforced');

  // Metadata that lies (understates byteLength) still gets caught on actual bytes.
  const lying = buildRevealFrames(makeItems(2, 3000));
  const doctored = JSON.parse(lying.metaFrame);
  for (const item of doctored.items) item.byteLength = 10;
  r.feed(Buffer.from(JSON.stringify(doctored)), false);
  r.feed(lying.binaryFrames[0], true);
  assert.throws(() => r.feed(lying.binaryFrames[1], true), /exceeded cap/, 'actual byte cap enforced');

  // After a rejection the reassembler is reusable.
  const ok = buildRevealFrames(makeItems(1, 100));
  r.feed(Buffer.from(ok.metaFrame), false);
  assert.ok(r.feed(ok.binaryFrames[0], true), 'reassembler usable after rejection');
  console.log('[test] caps OK');
}

// --- A lying count can never complete a batch with missing buffers ----------
{
  const r = new BatchReassembler();
  const built = buildRevealFrames(makeItems(2));
  const doctored = JSON.parse(built.metaFrame);
  doctored.count = 1; // lies: says 1, ships 2 item descriptors
  r.feed(Buffer.from(JSON.stringify(doctored)), false);
  const early = r.feed(built.binaryFrames[0], true);
  assert.strictEqual(early, null, 'must wait for every itemId, not the declared count');
  const batch = r.feed(built.binaryFrames[1], true);
  assert.ok(batch && batch.items.every((i) => i.buffer), 'all buffers present');
  console.log('[test] count-mismatch safety OK');
}

assert.ok(MAX_BATCH_ITEMS >= 50, 'default cap stays generous for real mission folders');
console.log('[dev-protocol-test] PASS');
