'use strict';

const crypto = require('crypto');

// See PROTOCOL.md — this module is the one place that knows how a
// reveal-batch is framed on the wire (one JSON text frame + `count` binary
// frames, each prefixed with its ASCII-UUID itemId). Both directions use it:
// clients build frames to *send* a reveal upstream, and both the relay server
// (per authenticated client) and the relay client (for fan-out it receives)
// reassemble with the same logic. Pure Node, no Electron — unit-testable.

const ITEM_ID_LENGTH = 36; // ASCII UUID prefix on each binary frame

// Sanity caps enforced by the reassembler — protects the host from a
// misconfigured client dumping a giant folder through the relay. Generous by
// design: PLAN.md's guidance is "low double digits" of photos per mission.
const MAX_BATCH_ITEMS = 100;
const MAX_BATCH_BYTES = 256 * 1024 * 1024;

/**
 * Builds the wire frames for a reveal batch.
 * items: [{ filename, mimeType, buffer }]
 * Returns { batchId, metaFrame (JSON string), binaryFrames (Buffer[]) }.
 */
function buildRevealFrames(items, { sourceType = 'prebundled', sharedBy = '' } = {}) {
  const batchId = crypto.randomUUID();
  const itemsWithIds = items.map((item) => ({
    itemId: crypto.randomUUID(),
    filename: item.filename,
    mimeType: item.mimeType,
    byteLength: item.buffer.length,
    sha256: crypto.createHash('sha256').update(item.buffer).digest('hex'),
  }));

  const metaFrame = JSON.stringify({
    type: 'reveal-batch',
    batchId,
    count: items.length,
    sourceType,
    sharedBy,
    ts: new Date().toISOString(),
    items: itemsWithIds,
  });

  const binaryFrames = items.map((item, i) =>
    Buffer.concat([Buffer.from(itemsWithIds[i].itemId, 'ascii'), item.buffer]),
  );

  return { batchId, metaFrame, binaryFrames };
}

/**
 * Incremental reassembler for one socket's incoming reveal-batches. Feed it
 * every message; it returns the completed batch
 * ({ batchId, sourceType, sharedBy, ts, items: [{filename, mimeType, buffer}] })
 * when the last binary frame lands, null otherwise. Throws on cap violations
 * (caller logs and moves on — the reassembler resets itself first).
 * A new metadata frame replaces any half-assembled batch (matches the
 * "one press = one full snapshot" semantics; no cross-batch merging).
 */
class BatchReassembler {
  constructor({ maxItems = MAX_BATCH_ITEMS, maxTotalBytes = MAX_BATCH_BYTES } = {}) {
    this.maxItems = maxItems;
    this.maxTotalBytes = maxTotalBytes;
    this._reset();
  }

  _reset() {
    this.meta = null;
    this.expectedIds = new Set();
    this.buffers = new Map();
    this.totalBytes = 0;
  }

  feed(data, isBinary) {
    if (!isBinary) {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return null; // not ours to police — ignore unparseable text frames
      }
      if (msg.type !== 'reveal-batch' || !Array.isArray(msg.items)) return null;

      if (msg.items.length > this.maxItems || msg.count > this.maxItems) {
        this._reset();
        throw new Error(`batch rejected: ${msg.items.length} items exceeds cap of ${this.maxItems}`);
      }
      const declaredBytes = msg.items.reduce((sum, item) => sum + (item.byteLength || 0), 0);
      if (declaredBytes > this.maxTotalBytes) {
        this._reset();
        throw new Error(`batch rejected: ${declaredBytes} bytes exceeds cap of ${this.maxTotalBytes}`);
      }

      this._reset();
      this.meta = msg;
      this.expectedIds = new Set(msg.items.map((item) => item.itemId));
      return null;
    }

    if (!this.meta) return null; // binary frame with no batch in flight — ignore

    const itemId = data.subarray(0, ITEM_ID_LENGTH).toString('ascii');
    if (!this.expectedIds.has(itemId)) return null; // not part of this batch — ignore

    const bytes = Buffer.from(data.subarray(ITEM_ID_LENGTH));
    this.totalBytes += bytes.length;
    if (this.totalBytes > this.maxTotalBytes) {
      // metadata understated the size — enforce on actual bytes too
      this._reset();
      throw new Error(`batch rejected: payload exceeded cap of ${this.maxTotalBytes} bytes`);
    }
    this.buffers.set(itemId, bytes);

    // Completion is judged by the actual per-item ids from the metadata, not
    // the declared `count` — a mismatched count can never produce a batch
    // with missing buffers.
    if (this.buffers.size < this.expectedIds.size) return null;

    const batch = {
      batchId: this.meta.batchId,
      sourceType: this.meta.sourceType,
      sharedBy: this.meta.sharedBy || '',
      ts: this.meta.ts,
      items: this.meta.items.map((item) => ({
        filename: item.filename,
        mimeType: item.mimeType,
        buffer: this.buffers.get(item.itemId),
      })),
    };
    this._reset();
    return batch;
  }
}

module.exports = {
  buildRevealFrames,
  BatchReassembler,
  ITEM_ID_LENGTH,
  MAX_BATCH_ITEMS,
  MAX_BATCH_BYTES,
};
