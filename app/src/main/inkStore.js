'use strict';

// Brief-mode ink. See design/brief-mode/HANDOFF.md.
//
// Main holds this, not the renderer — same reason as viewState.js (ROADMAP
// §5.2). But unlike viewState it is NOT pushed as part of the snapshot: at
// 30 Hz a full snapshot per stroke frame is absurd. Strokes reach a renderer
// as deltas on a dedicated IPC event, and the snapshot carries only a
// revision per image so a renderer that missed one can ask for the whole set
// again. `dev-ink-test` asserts the two paths agree, because the moment they
// disagree a pilot is looking at a different brief from everyone else and
// nothing on screen says so.
//
// Two properties this file exists to guarantee:
//
// 1. COORDINATES ARE NORMALISED AGAINST THE IMAGE, NEVER THE SCREEN.
//    {u,v} in 0..1, quantised to uint16. Surface size never enters a stored
//    value, so the same mark lands on the same image pixel on a 625-wide
//    window, an 850-wide one, and a VR quad — without anyone agreeing a
//    resolution. This only holds while the stage uses `object-fit: contain`
//    (components.css) and the app has no zoom or pan. Do not add either.
//
// 2. INK IS KEYED BY IMAGE CONTENT HASH, NEVER BY FILENAME.
//    blobStore already keys bytes by sha256. Keying by name would let a
//    re-shared file called `target.jpg` inherit a stranger's annotations —
//    the wrong ink is far worse than no ink.
//
// Pure Node, no Electron.

// A rejoining client is sent every stroke on the focused image. 500 is about
// 157 KB, comfortably smaller than the photo it annotates.
const DEFAULT_MAX_STROKES = 500;

// One pen stroke at 30 Hz for a minute is ~7 200 points. The cap exists so a
// stuck pointer cannot grow one stroke without bound; it is not expected to
// be reached in a real mark.
const DEFAULT_MAX_POINTS = 8192;

const U16_MAX = 65535;

/** 0..1 -> 0..65535. Out-of-range input is clamped, not rejected: a pointer
 *  dragged off the edge of the image should stop at the edge, not vanish. */
function quantise(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(U16_MAX, Math.round(x * U16_MAX)));
}

/** 0..65535 -> 0..1. On a 2000px image one step is 0.03px. */
function dequantise(n) {
  return n / U16_MAX;
}

function quantisePoint(p) {
  return { u: quantise(p.u), v: quantise(p.v) };
}

/**
 * Ink for one instance, one image at a time on screen but many in the store.
 *
 * Every mutator returns the delta that a renderer (or the relay) should apply,
 * or null when nothing changed. Returning the delta rather than the new state
 * is what keeps the 30 Hz path cheap.
 */
function createInkStore({ maxStrokes = DEFAULT_MAX_STROKES, maxPoints = DEFAULT_MAX_POINTS } = {}) {
  /** hash -> { order: strokeId[], strokes: Map, rev: number } */
  const images = new Map();

  function imageFor(hash) {
    let img = images.get(hash);
    if (!img) {
      img = { order: [], strokes: new Map(), rev: 0 };
      images.set(hash, img);
    }
    return img;
  }

  /**
   * PEN is an append stream: the presenter's pointer emits a few points per
   * frame under one strokeId, and each frame extends the same mark. That is
   * why a dropped pen frame is a real gap — unlike a shape, it cannot heal.
   * Returns { kind:'append', hash, rev, id, points } (the NEW points only).
   */
  function appendStroke(hash, { id, by = '', points = [] }) {
    if (!hash || !id || !points.length) return null;
    const img = imageFor(hash);
    let stroke = img.strokes.get(id);

    if (!stroke) {
      // At the cap, refuse the new mark rather than evicting an old one: the
      // brief someone already drew is worth more than the mark being started.
      if (img.order.length >= maxStrokes) return null;
      stroke = { id, tool: 'pen', by, points: [] };
      img.strokes.set(id, stroke);
      img.order.push(id);
    }

    const room = maxPoints - stroke.points.length;
    if (room <= 0) return null;
    const added = points.slice(0, room).map(quantisePoint);
    stroke.points.push(...added);
    img.rev += 1;
    return { kind: 'append', hash, rev: img.rev, id, tool: 'pen', by, points: added };
  }

  /**
   * ARROW and RING are parametric upserts, not point trails: the same
   * strokeId arrives repeatedly at 30 Hz carrying the CURRENT geometry, with
   * `final` on release. The rubber-band the clients watch IS the message
   * stream. Because each frame is the whole truth, a lost one heals on the
   * next — which is why shapes need no retransmission and pen does.
   *
   * `a` is the anchor (arrow tail / ring centre), `b` the dragged end
   * (arrow head / a point on the ring). Radius is derived at render time as a
   * fraction of image width, so it survives any surface size like everything
   * else here.
   */
  function upsertShape(hash, { id, tool, by = '', a, b, final = false }) {
    if (!hash || !id || !a || !b) return null;
    if (tool !== 'arrow' && tool !== 'ring') return null;
    const img = imageFor(hash);

    if (!img.strokes.has(id)) {
      if (img.order.length >= maxStrokes) return null;
      img.order.push(id);
    }
    const stroke = { id, tool, by, a: quantisePoint(a), b: quantisePoint(b), final: Boolean(final) };
    img.strokes.set(id, stroke);
    img.rev += 1;
    return { kind: 'upsert', hash, rev: img.rev, ...stroke };
  }

  /**
   * Removes one presenter's last COMMITTED mark on this image.
   *
   * Scoped to the caller so a slip cannot erase someone else's brief. Passing
   * no `by` undoes the most recent mark by anyone, which is what a host-only
   * v1 does — but the argument exists now so handing the pen to a callsign
   * later does not need this rewritten.
   */
  function undo(hash, by = null) {
    const img = images.get(hash);
    if (!img || !img.order.length) return null;
    for (let i = img.order.length - 1; i >= 0; i -= 1) {
      const stroke = img.strokes.get(img.order[i]);
      if (!stroke) continue;
      if (by !== null && stroke.by !== by) continue;
      img.order.splice(i, 1);
      img.strokes.delete(stroke.id);
      img.rev += 1;
      return { kind: 'undo', hash, rev: img.rev, id: stroke.id };
    }
    return null;
  }

  /** Wipes the focused image only. CLEAR is deliberately not "clear all". */
  function clear(hash) {
    const img = images.get(hash);
    if (!img || !img.order.length) return null;
    img.order = [];
    img.strokes = new Map();
    img.rev += 1;
    return { kind: 'clear', hash, rev: img.rev };
  }

  /** Everything on one image, in draw order. What a rejoining client gets. */
  function snapshot(hash) {
    const img = images.get(hash);
    if (!img) return { hash, rev: 0, strokes: [] };
    return {
      hash,
      rev: img.rev,
      strokes: img.order.map((id) => cloneStroke(img.strokes.get(id))),
    };
  }

  /**
   * hash -> rev, for the view snapshot. This is the ONLY ink that rides the
   * 3-second state push: a renderer compares its own rev per image and asks
   * for a full snapshot when it finds a gap.
   */
  function revisions() {
    const out = {};
    for (const [hash, img] of images) out[hash] = img.rev;
    return out;
  }

  /** Applies a delta produced by any of the mutators above. This is the
   *  client half: the relay fans deltas out, and every receiver replays them
   *  through here, so one implementation decides what a delta means. */
  function apply(delta) {
    if (!delta || !delta.hash) return null;
    switch (delta.kind) {
      case 'append':
        return appendRaw(delta);
      case 'upsert':
        return upsertRaw(delta);
      case 'undo': {
        const img = images.get(delta.hash);
        if (!img) return null;
        const at = img.order.indexOf(delta.id);
        if (at === -1) return null;
        img.order.splice(at, 1);
        img.strokes.delete(delta.id);
        img.rev = delta.rev;
        return delta;
      }
      case 'clear': {
        const img = imageFor(delta.hash);
        img.order = [];
        img.strokes = new Map();
        img.rev = delta.rev;
        return delta;
      }
      default:
        return null;
    }
  }

  // The apply-side twins of the mutators. They differ in one way that
  // matters: the points are ALREADY quantised, so re-quantising them would
  // divide by 65535 twice and collapse every mark into the top-left corner.
  function appendRaw({ hash, id, by = '', points = [], rev }) {
    const img = imageFor(hash);
    let stroke = img.strokes.get(id);
    if (!stroke) {
      if (img.order.length >= maxStrokes) return null;
      stroke = { id, tool: 'pen', by, points: [] };
      img.strokes.set(id, stroke);
      img.order.push(id);
    }
    const room = maxPoints - stroke.points.length;
    if (room <= 0) return null;
    stroke.points.push(...points.slice(0, room).map((p) => ({ u: p.u, v: p.v })));
    img.rev = rev;
    return { kind: 'append', hash, id, points, rev };
  }

  function upsertRaw({ hash, id, tool, by = '', a, b, final = false, rev }) {
    const img = imageFor(hash);
    if (!img.strokes.has(id)) {
      if (img.order.length >= maxStrokes) return null;
      img.order.push(id);
    }
    img.strokes.set(id, { id, tool, by, a: { ...a }, b: { ...b }, final: Boolean(final) });
    img.rev = rev;
    return { kind: 'upsert', hash, id, tool, by, a, b, final, rev };
  }

  /** Replaces one image's ink wholesale — the SNAPSHOT reply. */
  function load({ hash, rev = 0, strokes = [] }) {
    if (!hash) return;
    const img = imageFor(hash);
    img.order = strokes.map((s) => s.id);
    img.strokes = new Map(strokes.map((s) => [s.id, cloneStroke(s)]));
    img.rev = rev;
  }

  /** Ink is ephemeral: when a batch is replaced its images go with it. */
  function forget(hash) {
    return images.delete(hash);
  }

  function count(hash) {
    const img = images.get(hash);
    return img ? img.order.length : 0;
  }

  return {
    appendStroke,
    upsertShape,
    undo,
    clear,
    snapshot,
    revisions,
    apply,
    load,
    forget,
    count,
    get size() {
      return images.size;
    },
  };
}

function cloneStroke(s) {
  if (!s) return null;
  return s.tool === 'pen'
    ? { id: s.id, tool: 'pen', by: s.by, points: s.points.map((p) => ({ u: p.u, v: p.v })) }
    : { id: s.id, tool: s.tool, by: s.by, a: { ...s.a }, b: { ...s.b }, final: s.final };
}

module.exports = {
  createInkStore,
  quantise,
  dequantise,
  U16_MAX,
  DEFAULT_MAX_STROKES,
  DEFAULT_MAX_POINTS,
};
