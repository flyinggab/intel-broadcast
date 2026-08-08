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

// ---------------------------------------------------------------------------
// Brief mode — the realtime family. See design/brief-mode/HANDOFF.md §4.
//
// These ride a SEPARATE socket (`/rt`) from the reveal batches above, on the
// same port and the same token. The split is not tidiness: a 3 MB photo and a
// 26-byte stroke sharing one socket means the stroke waits behind the photo,
// and head-of-line blocking is exactly what a live brief cannot afford. It
// also means these frames never touch the reassembler.
//
// Two message kinds carry ink, and no third:
//   stroke  APPEND — pen. Each frame extends one mark. A lost frame is a
//           real gap in the line, which is why pen is the only stream.
//   shape   UPSERT — arrow and ring. Each frame carries the CURRENT geometry
//           in full, so a lost frame heals on the next one and the
//           rubber-band the clients watch simply IS the message stream.
//
// TEXT is deliberately absent. Typing has no place in VR, and a tool that
// works for desktop pilots but not VR ones splits the tool set.
// ---------------------------------------------------------------------------

/** The path the realtime socket upgrades on. `/` stays the bulk socket. */
const REALTIME_PATH = '/rt';

// A realtime frame is tiny by construction — the largest is a snapshot reply,
// ~157 KB at the 500-stroke cap. A megabyte is generous and still refuses
// anything trying to push a photo down this socket.
const MAX_REALTIME_FRAME_BYTES = 1024 * 1024;

// Every field a client may send. Anything else is dropped rather than
// forwarded: the relay is the one place that can stop a malformed or hostile
// frame from reaching every pilot's screen at once.
const BRIEF_TYPES = new Set([
  'brief-present-start',
  'brief-present-stop',
  'brief-focus',
  'brief-stroke',
  'brief-shape',
  'brief-cursor',
  'brief-undo',
  'brief-clear',
  'brief-snapshot-req',
  'brief-snapshot',
  'brief-card',
  'brief-card-tick',
]);

// A route card is a page of paper. Far past any real one, and the only job
// here is to stop a client making every other pilot hold an unbounded map.
const MAX_TICKS = 200;

/**
 * Validates a set of step ticks: `{ "0": true, "3": false }`.
 *
 * An OVERRIDE map, not the whole truth — a step missing from it is whatever
 * the card itself said. Sent alongside a card so a lead who has already flown
 * three legs does not hand out a card claiming nothing has happened yet.
 */
function tickMap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length > MAX_TICKS) return null;
  const out = {};
  for (const k of keys) {
    if (!/^\d{1,4}$/.test(k)) return null;
    if (typeof v[k] !== 'boolean') return null;
    out[k] = v[k];
  }
  return out;
}

/** Types only a presenter may originate. `brief-snapshot-req` is deliberately
 *  not here — any client may ask for the ink on the image it is looking at. */
const PRESENTER_ONLY = new Set([
  'brief-present-start',
  'brief-present-stop',
  'brief-focus',
  'brief-stroke',
  'brief-shape',
  'brief-cursor',
  'brief-undo',
  'brief-clear',
]);

const isU16 = (n) => Number.isInteger(n) && n >= 0 && n <= 65535;
const isPoint = (p) => Boolean(p) && isU16(p.u) && isU16(p.v);
const isHash = (h) => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h);

/**
 * Parses and validates one realtime text frame.
 *
 * Returns the message, or null for anything it does not recognise. Every
 * coordinate is validated as an already-quantised uint16 — the wire never
 * carries floats, so a client cannot make everyone else's renderer divide by
 * 65535 twice, and a NaN cannot reach a canvas call.
 */
function parseBriefMessage(data) {
  let msg;
  try {
    msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || !BRIEF_TYPES.has(msg.type)) return null;

  switch (msg.type) {
    case 'brief-present-start':
    case 'brief-present-stop':
      return { type: msg.type, presenter: str(msg.presenter) };

    case 'brief-focus':
      if (!isHash(msg.hash)) return null;
      return {
        type: msg.type,
        hash: msg.hash,
        batchId: str(msg.batchId),
        filename: str(msg.filename),
        presenter: str(msg.presenter),
      };

    case 'brief-stroke': {
      if (!isHash(msg.hash) || !str(msg.id)) return null;
      if (!Array.isArray(msg.points) || !msg.points.length || msg.points.length > 64) return null;
      if (!msg.points.every(isPoint)) return null;
      return {
        type: msg.type,
        hash: msg.hash,
        id: str(msg.id),
        presenter: str(msg.presenter),
        points: msg.points.map((p) => ({ u: p.u, v: p.v })),
      };
    }

    case 'brief-shape': {
      if (!isHash(msg.hash) || !str(msg.id)) return null;
      if (msg.tool !== 'arrow' && msg.tool !== 'ring') return null;
      if (!isPoint(msg.a) || !isPoint(msg.b)) return null;
      return {
        type: msg.type,
        hash: msg.hash,
        id: str(msg.id),
        tool: msg.tool,
        presenter: str(msg.presenter),
        a: { u: msg.a.u, v: msg.a.v },
        b: { u: msg.b.u, v: msg.b.v },
        final: msg.final === true,
      };
    }

    case 'brief-cursor':
      if (!isPoint(msg)) return null;
      return { type: msg.type, u: msg.u, v: msg.v, presenter: str(msg.presenter) };

    case 'brief-undo':
      if (!isHash(msg.hash)) return null;
      return { type: msg.type, hash: msg.hash, id: str(msg.id), presenter: str(msg.presenter) };

    case 'brief-clear':
      if (!isHash(msg.hash)) return null;
      return { type: msg.type, hash: msg.hash, presenter: str(msg.presenter) };

    case 'brief-snapshot-req':
      if (!isHash(msg.hash)) return null;
      return { type: msg.type, hash: msg.hash };

    // The card DATA, not a picture of it. Layouts ship inside the app, so the
    // receiver renders it with its own copy of the template and it looks
    // exactly as it does on the sender — a few KB of JSON rather than an
    // image, and legible at any surface size because it is still text.
    case 'brief-card': {
      if (!msg.card || typeof msg.card !== 'object' || Array.isArray(msg.card)) return null;
      if (typeof msg.card.layout !== 'string' || !msg.card.layout) return null;
      // The steps already flown ride WITH the card. Sending them separately
      // would leave a window where the receiver's sheet showed a mission not
      // yet started, and casting mid-flight is the normal case.
      const ticks = msg.ticks === undefined ? {} : tickMap(msg.ticks);
      if (!ticks) return null;
      return { type: msg.type, card: msg.card, ticks, presenter: str(msg.presenter) };
    }

    // One step flown, or un-flown. Addressed by the CARD's content hash, so a
    // pilot holding a different card — or none — ignores it instead of ticking
    // whatever happens to be on step 4 of theirs.
    case 'brief-card-tick': {
      if (!isHash(msg.hash)) return null;
      if (!Number.isInteger(msg.index) || msg.index < 0 || msg.index > 9999) return null;
      if (typeof msg.done !== 'boolean') return null;
      return {
        type: msg.type,
        hash: msg.hash,
        index: msg.index,
        done: msg.done,
        presenter: str(msg.presenter),
      };
    }

    case 'brief-snapshot': {
      if (!isHash(msg.hash)) return null;
      if (!Array.isArray(msg.strokes)) return null;
      return {
        type: msg.type,
        hash: msg.hash,
        rev: Number.isInteger(msg.rev) ? msg.rev : 0,
        strokes: msg.strokes,
      };
    }

    default:
      return null;
  }
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

/**
 * Stamps the authenticated identity onto a message before fan-out.
 *
 * Same rule as `sharedBy` on a reveal batch: whatever the sender claimed is
 * discarded. A client cannot present as someone else by editing a field.
 */
function stampPresenter(msg, callsign) {
  return { ...msg, presenter: callsign || '' };
}

module.exports = {
  buildRevealFrames,
  BatchReassembler,
  ITEM_ID_LENGTH,
  MAX_BATCH_ITEMS,
  MAX_BATCH_BYTES,
  REALTIME_PATH,
  MAX_REALTIME_FRAME_BYTES,
  BRIEF_TYPES,
  PRESENTER_ONLY,
  parseBriefMessage,
  stampPresenter,
};
