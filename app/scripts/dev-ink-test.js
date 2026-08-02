'use strict';

// Unit test for inkStore.js — brief mode's ink. Pure Node, no Electron.
//
// Usage: node scripts/dev-ink-test.js
//
// The headline assertion is DELTA/SNAPSHOT EQUIVALENCE. Two clients see the
// same brief by two different routes: one watched every stroke arrive as a
// delta, the other joined late and was handed a snapshot. If those routes can
// disagree, two pilots are looking at different pictures and nothing on
// screen says so — which is worse than the ink not working at all.

const assert = require('assert');
const {
  createInkStore,
  quantise,
  dequantise,
  U16_MAX,
  DEFAULT_MAX_STROKES,
} = require('../src/main/inkStore');

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

// ---------------------------------------------------------------------------
// Normalisation: the reason no client resolution is ever agreed or enforced.
// ---------------------------------------------------------------------------
{
  assert.strictEqual(quantise(0), 0);
  assert.strictEqual(quantise(1), U16_MAX);
  assert.strictEqual(dequantise(U16_MAX), 1);

  // Out of range clamps rather than wrapping or vanishing: a pointer dragged
  // off the image should stop at the edge.
  assert.strictEqual(quantise(-0.5), 0, 'negative clamps to the left edge');
  assert.strictEqual(quantise(1.5), U16_MAX, 'over 1 clamps to the right edge');
  assert.strictEqual(quantise(NaN), 0, 'NaN cannot poison the store');

  // The claim in the design doc: 0.03px on a 2000px image. Check the worst
  // case across the whole range rather than a friendly sample.
  let worstPx = 0;
  for (let i = 0; i <= 10000; i += 1) {
    const u = i / 10000;
    worstPx = Math.max(worstPx, Math.abs(dequantise(quantise(u)) - u) * 2000);
  }
  assert.ok(worstPx < 0.03, `round-trip error ${worstPx.toFixed(4)}px must stay under 0.03px`);

  // The property that matters more than the number: the SAME stored value
  // resolves to the same image pixel at any surface size, because surface
  // size never entered it.
  const stored = quantise(0.4237);
  for (const w of [625, 850, 1262, 2048]) {
    const px = dequantise(stored) * w;
    assert.ok(Math.abs(px / w - 0.4237) < 1e-4, `resolves consistently at ${w}px wide`);
  }
  console.log(`[test] normalisation round-trip OK (worst ${worstPx.toFixed(4)}px on a 2000px image)`);
}

// ---------------------------------------------------------------------------
// PEN appends, SHAPE upserts. The two kinds behave differently on purpose.
// ---------------------------------------------------------------------------
{
  const ink = createInkStore();

  ink.appendStroke(HASH, { id: 's1', by: 'GHOST', points: [{ u: 0.1, v: 0.1 }, { u: 0.2, v: 0.2 }] });
  const d = ink.appendStroke(HASH, { id: 's1', by: 'GHOST', points: [{ u: 0.3, v: 0.3 }] });

  assert.strictEqual(ink.count(HASH), 1, 'the second frame extends the same mark, it does not start a new one');
  assert.strictEqual(ink.snapshot(HASH).strokes[0].points.length, 3, 'all three points are on the stroke');
  assert.deepStrictEqual(d.points, [{ u: quantise(0.3), v: quantise(0.3) }], 'the delta carries only the NEW points');

  // A shape repeated at 30 Hz must not accumulate — each frame is the whole
  // truth, which is exactly why a lost shape frame heals on the next one.
  for (const r of [0.1, 0.2, 0.3]) {
    ink.upsertShape(HASH, { id: 'r1', tool: 'ring', by: 'GHOST', a: { u: 0.5, v: 0.5 }, b: { u: 0.5 + r, v: 0.5 } });
  }
  assert.strictEqual(ink.count(HASH), 2, '30 repeats of one ring is still one ring');
  const ring = ink.snapshot(HASH).strokes[1];
  assert.strictEqual(ring.b.u, quantise(0.8), 'the ring carries the LAST geometry, not the first');
  assert.strictEqual(ring.final, false, 'not final until release says so');

  ink.upsertShape(HASH, { id: 'r1', tool: 'ring', by: 'GHOST', a: { u: 0.5, v: 0.5 }, b: { u: 0.8, v: 0.5 }, final: true });
  assert.strictEqual(ink.snapshot(HASH).strokes[1].final, true, 'release commits');
  assert.strictEqual(ink.count(HASH), 2, 'committing does not duplicate');

  assert.strictEqual(ink.upsertShape(HASH, { id: 'x', tool: 'text', a: {}, b: {} }), null, 'TEXT was cut; no tool sneaks in');
  console.log('[test] pen appends, shapes upsert, tool set is closed');
}

// ---------------------------------------------------------------------------
// THE HEADLINE: a client that replayed deltas and one handed a snapshot must
// hold the same picture.
// ---------------------------------------------------------------------------
{
  const presenter = createInkStore();
  const watcher = createInkStore(); // replays every delta
  const deltas = [];

  const record = (d) => {
    if (d) deltas.push(d);
    return d;
  };

  record(presenter.appendStroke(HASH, { id: 'p1', by: 'GHOST', points: [{ u: 0.1, v: 0.9 }, { u: 0.15, v: 0.85 }] }));
  record(presenter.appendStroke(HASH, { id: 'p1', by: 'GHOST', points: [{ u: 0.2, v: 0.8 }] }));
  record(presenter.upsertShape(HASH, { id: 'a1', tool: 'arrow', by: 'GHOST', a: { u: 0.3, v: 0.3 }, b: { u: 0.6, v: 0.4 } }));
  record(presenter.upsertShape(HASH, { id: 'a1', tool: 'arrow', by: 'GHOST', a: { u: 0.3, v: 0.3 }, b: { u: 0.7, v: 0.45 }, final: true }));
  record(presenter.appendStroke(HASH, { id: 'p2', by: 'GHOST', points: [{ u: 0.5, v: 0.5 }] }));
  record(presenter.undo(HASH, 'GHOST'));
  record(presenter.upsertShape(HASH, { id: 'r9', tool: 'ring', by: 'GHOST', a: { u: 0.2, v: 0.2 }, b: { u: 0.25, v: 0.2 }, final: true }));

  for (const d of deltas) watcher.apply(d);

  assert.deepStrictEqual(
    watcher.snapshot(HASH),
    presenter.snapshot(HASH),
    'replaying the deltas must produce exactly the presenter\'s picture',
  );

  // And the late joiner, handed the snapshot cold.
  const latecomer = createInkStore();
  latecomer.load(presenter.snapshot(HASH));
  assert.deepStrictEqual(latecomer.snapshot(HASH), presenter.snapshot(HASH), 'a snapshot reproduces it too');

  // Quantising twice would divide by 65535 twice and collapse everything into
  // the corner. This is the specific bug the apply-side twins exist to avoid.
  const firstPoint = latecomer.snapshot(HASH).strokes[0].points[0];
  assert.strictEqual(firstPoint.u, quantise(0.1), 'applied points are not re-quantised');
  assert.ok(firstPoint.u > 1000, 'a double-quantised point would be near zero — it is not');

  assert.strictEqual(presenter.snapshot(HASH).rev, watcher.snapshot(HASH).rev, 'revisions agree');
  console.log(`[test] delta replay == snapshot (${deltas.length} deltas, rev ${presenter.snapshot(HASH).rev})`);
}

// ---------------------------------------------------------------------------
// Scope: a slip cannot erase the brief.
// ---------------------------------------------------------------------------
{
  const ink = createInkStore();
  ink.appendStroke(HASH, { id: 'mine', by: 'GHOST', points: [{ u: 0.1, v: 0.1 }] });
  ink.appendStroke(HASH, { id: 'theirs', by: 'JOKER', points: [{ u: 0.2, v: 0.2 }] });
  ink.appendStroke(OTHER, { id: 'elsewhere', by: 'GHOST', points: [{ u: 0.3, v: 0.3 }] });

  const undone = ink.undo(HASH, 'GHOST');
  assert.strictEqual(undone.id, 'mine', 'undo skips past another callsign\'s mark to find my own');
  assert.strictEqual(ink.count(HASH), 1, 'their mark survives');
  assert.strictEqual(ink.undo(HASH, 'GHOST'), null, 'nothing of mine left to undo');

  ink.clear(HASH);
  assert.strictEqual(ink.count(HASH), 0, 'CLEAR wipes the focused image');
  assert.strictEqual(ink.count(OTHER), 1, 'CLEAR is scoped to one image, never the whole brief');
  assert.strictEqual(ink.clear(HASH), null, 'clearing an empty image is not a change');
  console.log('[test] undo and clear are scoped to one presenter and one image');
}

// ---------------------------------------------------------------------------
// Ink belongs to the image, not the page position or the filename.
// ---------------------------------------------------------------------------
{
  const ink = createInkStore();
  ink.appendStroke(HASH, { id: 's', by: 'GHOST', points: [{ u: 0.4, v: 0.4 }] });

  // Paging away and back costs nothing and loses nothing.
  assert.strictEqual(ink.count(HASH), 1);
  assert.strictEqual(ink.count(OTHER), 0, 'a different image starts clean');
  assert.deepStrictEqual(ink.revisions(), { [HASH]: 1 }, 'revisions report per image');

  ink.forget(HASH);
  assert.strictEqual(ink.count(HASH), 0, 'ink dies with its batch — ephemeral by default');
  console.log('[test] ink is per image, keyed by content hash');
}

// ---------------------------------------------------------------------------
// Caps. Refusing a new mark beats evicting a brief someone already drew.
// ---------------------------------------------------------------------------
{
  const ink = createInkStore({ maxStrokes: 3, maxPoints: 4 });
  for (let i = 0; i < 5; i += 1) ink.appendStroke(HASH, { id: `s${i}`, points: [{ u: 0.1, v: 0.1 }] });
  assert.strictEqual(ink.count(HASH), 3, 'stroke cap holds');
  assert.strictEqual(ink.snapshot(HASH).strokes[0].id, 's0', 'the oldest mark is kept, not evicted');

  ink.appendStroke(HASH, { id: 's0', points: [{ u: 0.2, v: 0.2 }, { u: 0.3, v: 0.3 }, { u: 0.4, v: 0.4 }, { u: 0.5, v: 0.5 }] });
  assert.strictEqual(ink.snapshot(HASH).strokes[0].points.length, 4, 'point cap holds within a stroke');
  assert.strictEqual(ink.appendStroke(HASH, { id: 's0', points: [{ u: 0.6, v: 0.6 }] }), null, 'a full stroke reports no change');

  assert.strictEqual(DEFAULT_MAX_STROKES, 500, 'the shipped cap is the one the rejoin-size estimate assumed');
  console.log('[test] caps refuse rather than evict');
}

// ---------------------------------------------------------------------------
// Junk in cannot corrupt the store.
// ---------------------------------------------------------------------------
{
  const ink = createInkStore();
  assert.strictEqual(ink.appendStroke(HASH, { id: 's', points: [] }), null, 'an empty frame is not a change');
  assert.strictEqual(ink.appendStroke('', { id: 's', points: [{ u: 0, v: 0 }] }), null, 'no hash, no ink');
  assert.strictEqual(ink.undo('nope'), null);
  assert.strictEqual(ink.clear('nope'), null);
  assert.strictEqual(ink.apply(null), null);
  assert.strictEqual(ink.apply({ hash: HASH, kind: 'nonsense' }), null, 'unknown delta kinds are ignored');
  assert.deepStrictEqual(ink.snapshot('never-seen'), { hash: 'never-seen', rev: 0, strokes: [] });
  assert.strictEqual(ink.size, 0, 'none of that created an image');
  console.log('[test] malformed input is ignored, not stored');
}

console.log('[dev-ink-test] PASS');
