'use strict';

// Kneeboard cards: the validator and the binding resolver. Pure Node.
//
//   node scripts/dev-card-test.js
//
// Driven by the REAL template and the REAL example card in design/kneeboard/,
// not by fixtures written to match the code. If the design's card and template
// stop agreeing, this fails — which is the point: the handoff says the template
// and the card are the source of truth and the mockup is what goes stale.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { resolveCard } = require('../src/main/card');

const LAYOUT = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'resources', 'layouts', 'strike-package.layout.json'), 'utf8'),
);
const CARD = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'design', 'kneeboard', 'foxhunt2-roman1.card.json'), 'utf8'),
);

const clone = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// The shipped example resolves cleanly. `verify-bindings.js` is the seed of
// this and stays where it is; this is the same check inside the app.
// ---------------------------------------------------------------------------
{
  const { ok, errors, card } = resolveCard({ layout: LAYOUT, card: CARD });
  assert.deepStrictEqual(errors, [], 'the shipped example card must resolve with no errors');
  assert.strictEqual(ok, true);

  // ONE card page, plus MAP. The handoff corrected a PLAN/CARD/MAP split:
  // paging to find your bullseye mid-flight is the failure a kneeboard exists
  // to prevent.
  assert.deepStrictEqual(card.pages.map((p) => p.id), ['card', 'map']);

  const cardPage = card.pages[0];
  const byType = (t) => cardPage.blocks.filter((b) => b.type === t);

  const header = byType('fields')[0];
  assert.strictEqual(header.band, 'header');
  const bullseye = header.items.find((i) => i.label === 'BULLSEYE');
  assert.ok(bullseye && bullseye.value.length > 0, 'the header must carry a resolved bullseye');
  assert.strictEqual(bullseye.style, 'mono');

  // NOT asserted: the 17 steps the handoff calls for. The shipped example card
  // still carries 11 and stops at RTB — the recovery it says you need when it
  // is going wrong is missing from the CONTENT, not the template. Writing it
  // would mean inventing marshal stacks and Case I numbers for a real mission,
  // which is the owner's to supply. Recorded in the handoff's honest gaps.
  const route = byType('steps')[0];
  assert.ok(route.rows.length > 0, 'the route must resolve');
  assert.ok(
    route.rows.every((r) => typeof r.name === 'string' && typeof r.done === 'boolean'),
    'every step resolves to strings plus a done flag',
  );
  // Four real columns on every row — nothing collapses at this width.
  assert.ok(route.rows.some((r) => r.note !== ''), 'notes must survive to the render model');

  const targets = byType('table').find((b) => b.title === 'TARGETS');
  assert.ok(targets.rows.length > 0);
  assert.ok(
    targets.rows[0].cells.some((c) => /^N\d/.test(c.value)),
    'targets carry coordinates in the revised card',
  );

  // `mark` is a per-row flag from the CONTENT: the template does not know
  // which tanker is next.
  const tankers = byType('table').find((b) => b.title.includes('TANKER'));
  assert.strictEqual(tankers.rows.filter((r) => r.marked).length, 1, 'exactly one row is flagged next');

  console.log(`[test] the shipped card resolves: ${cardPage.blocks.length} blocks, ${route.rows.length} route steps`);
  if (route.rows.length < 17) {
    console.log(`[test] note: the handoff calls for 17 steps; the example card supplies ${route.rows.length}`);
  }
}

// ---------------------------------------------------------------------------
// Failures are LOUD and total. A half-rendered card still looks like the
// mission, which is worse than a refused one.
// ---------------------------------------------------------------------------
{
  const missing = clone(CARD);
  delete missing.comms;
  const { ok, errors } = resolveCard({ layout: LAYOUT, card: missing });
  assert.strictEqual(ok, false);
  assert.ok(
    errors.some((e) => e.includes('missing "comms"')),
    `a card without a required section must say so, got ${JSON.stringify(errors.slice(0, 3))}`,
  );

  // An unresolved path with no fallback is an error, never a silent blank: a
  // blank where a frequency should be reads as "frequency: blank".
  const noFreq = clone(CARD);
  delete noFreq.comms.primary[0].freq;
  const dropped = resolveCard({ layout: LAYOUT, card: noFreq });
  assert.strictEqual(dropped.ok, false);
  assert.ok(dropped.errors.some((e) => e.includes('{freq}')), 'a missing value with no fallback must fail');

  // ...but a declared fallback is exactly how a card says "not applicable".
  const noTacan = clone(CARD);
  delete noTacan.comms.primary[0].tacan;
  const withFallback = resolveCard({ layout: LAYOUT, card: noTacan });
  assert.deepStrictEqual(withFallback.errors, [], '{tacan|dash} must absorb a missing tacan');
  const row = withFallback.card.pages[0].blocks.find((b) => b.title === 'COMM 1').rows[0];
  assert.ok(row.cells.some((c) => c.value === '—'), 'and render an em dash');

  console.log('[test] missing requires and unfallback-ed paths fail loudly; declared fallbacks do not');
}

// ---------------------------------------------------------------------------
// A card is untrusted. These are the ways a hostile one would try to reach
// past the page it is drawn on.
// ---------------------------------------------------------------------------
{
  // Images are content hashes, never URLs — that is what stops a card phoning
  // out the moment one arrives over the relay.
  for (const evil of ['https://evil.example/pixel.png', 'javascript:alert(1)', '../../etc/passwd', '']) {
    const card = clone(CARD);
    card.map.blob = evil;
    const { ok, errors } = resolveCard({ layout: LAYOUT, card });
    assert.strictEqual(ok, false, `image source "${evil}" must be refused`);
    assert.ok(errors.some((e) => e.includes('content hash')));
  }

  // An unknown block type is an import failure, not something rendered
  // generically. This is the mechanism by which a card cannot introduce a new
  // kind of thing onto a pilot's knee.
  const oddLayout = clone(LAYOUT);
  oddLayout.pages[0].blocks.push({ type: 'iframe', src: 'https://evil.example' });
  const odd = resolveCard({ layout: oddLayout, card: CARD });
  assert.strictEqual(odd.ok, false);
  assert.ok(odd.errors.some((e) => e.includes('unknown block type "iframe"')));

  // A template may not carry appearance. A card that can carry style is a card
  // that can break the cockpit.
  const styled = clone(LAYOUT);
  styled.pages[0].blocks[0].items[0].color = '#ff0000';
  const withStyle = resolveCard({ layout: styled, card: CARD });
  assert.strictEqual(withStyle.ok, false);
  assert.ok(withStyle.errors.some((e) => e.includes('style belongs to the EFB')));

  // Nested objects never reach the renderer as values — it writes textContent
  // and would print [object Object] on a pilot's knee.
  const objectValue = clone(CARD);
  objectValue.flight.callsign = { toString: 'nice try' };
  const objected = resolveCard({ layout: LAYOUT, card: objectValue });
  assert.strictEqual(objected.ok, false);
  assert.ok(objected.errors.some((e) => e.includes('not a value')));

  console.log('[test] untrusted cards: no URLs, no unknown blocks, no style, no objects');
}

// ---------------------------------------------------------------------------
// `when` omits, it does not error. A card with no MAP is a complete card.
// ---------------------------------------------------------------------------
{
  const noMap = clone(CARD);
  delete noMap.map;
  const { ok, errors, card } = resolveCard({ layout: LAYOUT, card: noMap });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(card.pages.map((p) => p.id), ['card'], 'no map means no MAP page, not an error');

  const noMids = clone(CARD);
  delete noMids.comms.mids;
  const without = resolveCard({ layout: LAYOUT, card: noMids });
  assert.deepStrictEqual(without.errors, []);
  assert.ok(
    !without.card.pages[0].blocks.some((b) => b.title === 'MIDS'),
    'a block whose `when` is absent is omitted entirely',
  );

  // An empty array is absent, not a heading with nothing under it.
  const emptyTargets = clone(CARD);
  emptyTargets.route.targets = [];
  const empty = resolveCard({ layout: LAYOUT, card: emptyTargets });
  assert.ok(!empty.card.pages[0].blocks.some((b) => b.title === 'TARGETS'));

  console.log('[test] `when` omits cleanly: no map page, no MIDS block, no empty TARGETS heading');
}

// ---------------------------------------------------------------------------
// The FULL fixture. The shipped example card stops at RTB; this one carries
// the 17 steps §1 calls for, including the recovery — feet wet, marshal, push,
// Case I, trap, bolter-to-divert — and deliberately drops three values so the
// declared fallbacks are exercised rather than merely parsed.
//
// Its mission data is fictional and it says so in its own title. It exists to
// prove the template survives a card that fills the sheet.
// ---------------------------------------------------------------------------
{
  const full = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'card-full.card.json'), 'utf8'));
  const { ok, errors, card } = resolveCard({ layout: LAYOUT, card: full });
  assert.deepStrictEqual(errors, [], 'the full fixture must resolve cleanly');
  assert.strictEqual(ok, true);

  const steps = card.pages[0].blocks.find((b) => b.type === 'steps');
  assert.strictEqual(steps.rows.length, 17, '§1 calls for seventeen steps, recovery included');
  const names = steps.rows.map((r) => r.name);
  for (const needed of ['FEET WET', 'MARSHAL', 'PUSH', 'CASE I', 'TRAP', 'BOLTER']) {
    assert.ok(names.includes(needed), `the recovery must include ${needed} — it is the part you need when it is going wrong`);
  }

  // The fallbacks, actually rendering. `blank` is empty, `dash` is an em dash;
  // both are how a card says "not applicable" without failing the import.
  assert.strictEqual(steps.rows[12].note, '', '{note|blank} renders empty');
  const tables = card.pages[0].blocks.filter((b) => b.type === 'table');
  const targets = tables.find((b) => b.title === 'TARGETS');
  assert.ok(targets.rows[3].cells.some((c) => c.value === '—'), '{coord|dash} renders an em dash');
  const tankers = tables.find((b) => b.title.includes('TANKER'));
  assert.ok(tankers.rows[3].cells.some((c) => c.value === '—'), '{tacan|dash} likewise');

  console.log(`[test] the full fixture: ${steps.rows.length} steps through the trap, fallbacks rendering`);
}

console.log('[dev-card-test] PASS');
