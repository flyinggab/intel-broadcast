'use strict';

// Unit test for viewState.js — the main-process store that both windows are a
// pure function of (ROADMAP §5.2). Covers the auto-switch rule the BRIEF
// specifies (rule C), which is the fiddly part.
//
// Usage: node scripts/dev-viewstate-test.js

const assert = require('assert');
const { createViewState, INTERACTION_GRACE_MS } = require('../src/main/viewState');

const items = (n) => Array.from({ length: n }, (_, i) => ({ filename: `${i}.jpg`, url: `intel://blob/${i}` }));

// A controllable clock: rule C is entirely about elapsed time.
function withClock() {
  let t = 1_000_000;
  const view = createViewState({ now: () => t });
  return { view, advance: (ms) => (t += ms), at: () => t };
}

// --- Rule C: switch on arrival when the pilot is idle -----------------------
{
  const { view } = withClock();
  const { switched } = view.addBatch({ sharedBy: 'alpha', items: items(3) });
  assert.strictEqual(switched, true, 'idle pilot: arrival takes the screen');
  assert.strictEqual(view.state.page, 'frame');
  assert.strictEqual(view.snapshot().banner.switched, true, 'a switch MUST be announced');
  assert.strictEqual(view.snapshot().unread, 0, 'what it switched to is not unread');
  console.log('[test] rule C: idle -> switches and says so');
}

// --- Rule C: do NOT switch within the grace window --------------------------
{
  const { view, advance } = withClock();
  view.addBatch({ sharedBy: 'alpha', items: items(2) }); // seeds the stage
  view.step(1); // the pilot is reading
  advance(INTERACTION_GRACE_MS - 1000);

  const { switched } = view.addBatch({ sharedBy: 'bravo', items: items(4) });
  assert.strictEqual(switched, false, 'must not yank the page out from under a reader');
  assert.strictEqual(view.snapshot().banner, null, 'no banner when it did not switch');
  assert.strictEqual(view.snapshot().unread, 1, 'suppressed arrival is badged instead');
  console.log('[test] rule C: recent interaction -> badges instead of switching');
}

// --- Rule C: switches again once the window has elapsed ---------------------
{
  const { view, advance } = withClock();
  view.addBatch({ sharedBy: 'alpha', items: items(1) });
  view.step(1);
  advance(INTERACTION_GRACE_MS + 1);
  const { switched } = view.addBatch({ sharedBy: 'bravo', items: items(1) });
  assert.strictEqual(switched, true, 'grace window expires');
  console.log('[test] rule C: grace window expires correctly');
}

// --- The escape hatch on the PILOT page -------------------------------------
{
  const { view } = withClock();
  view.state.autoShow = false;
  const { switched } = view.addBatch({ sharedBy: 'alpha', items: items(2) });
  assert.strictEqual(switched, false, 'SHOW NEW INTEL ON ARRIVAL off means never switch');
  assert.strictEqual(view.snapshot().unread, 1);
  console.log('[test] auto-show toggle defeats switching entirely');
}

// --- Opening an older batch -------------------------------------------------
{
  const { view, advance } = withClock();
  const first = view.addBatch({ sharedBy: 'alpha', items: items(2) }).entry;
  advance(INTERACTION_GRACE_MS + 1);
  view.addBatch({ sharedBy: 'bravo', items: items(1) });
  assert.strictEqual(view.snapshot().batches[0].open, true, 'newest is on the stage');

  view.openBatch(first.id);
  const snap = view.snapshot();
  assert.strictEqual(snap.page, 'frame');
  assert.strictEqual(snap.batches[1].open, true, 'the older batch is now open');
  assert.strictEqual(snap.batches[1].unread, false, 'opening clears its unread mark');
  assert.strictEqual(snap.frame.sharedBy, 'alpha');
  assert.strictEqual(view.openBatch(9999), null, 'unknown id is a no-op');
  console.log('[test] opening an older batch works and marks it read');
}

// --- Paging wraps and stays inside the open batch ---------------------------
{
  const { view } = withClock();
  view.addBatch({ sharedBy: 'alpha', items: items(3) });
  assert.strictEqual(view.snapshot().frame.index, 0);
  view.step(-1);
  assert.strictEqual(view.snapshot().frame.index, 2, 'wraps backwards');
  view.step(1);
  assert.strictEqual(view.snapshot().frame.index, 0, 'wraps forwards');
  assert.strictEqual(view.snapshot().frame.count, 3);
  console.log('[test] paging wraps within the open batch');
}

// --- Eviction keeps the newest ----------------------------------------------
{
  const view = createViewState({ maxBatches: 3 });
  for (const who of ['a', 'b', 'c', 'd']) view.addBatch({ sharedBy: who, items: items(1) });
  const snap = view.snapshot();
  assert.strictEqual(snap.batches.length, 3);
  assert.deepStrictEqual(snap.batches.map((b) => b.sharedBy), ['d', 'c', 'b']);
  console.log('[test] history caps and drops the oldest');
}

// --- Share selection ---------------------------------------------------------
{
  const { view } = withClock();
  view.setGallery({
    folder: '/photos',
    photos: [
      { filename: 'a.jpg', selected: true },
      { filename: 'b.jpg', selected: true },
    ],
  });
  assert.deepStrictEqual(view.selectedFilenames(), ['a.jpg', 'b.jpg']);
  view.togglePhoto('a.jpg');
  assert.deepStrictEqual(view.selectedFilenames(), ['b.jpg']);
  view.setAllSelected(false);
  assert.deepStrictEqual(view.selectedFilenames(), []);
  assert.strictEqual(view.snapshot().selectedCount, 0);
  view.setAllSelected(true);
  assert.strictEqual(view.snapshot().selectedCount, 2);
  // Touching the gallery counts as interaction, so a reveal landing right
  // after must not steal the screen.
  assert.strictEqual(view.recentlyInteracted(), true);
  console.log('[test] share selection + interaction tracking');
}

// --- FAULT owns the screen, but never steals a photo being read -------------
{
  const { view } = withClock();
  view.setConnection({ connected: false, relayLabel: 'gab-pc' });
  assert.strictEqual(view.state.page, 'fault');
  view.setConnection({ connected: true });
  assert.strictEqual(view.state.page, 'brief', 'recovers off the fault page');

  view.addBatch({ sharedBy: 'alpha', items: items(1) }); // page === frame
  view.setConnection({ connected: false });
  assert.strictEqual(view.state.page, 'frame', 'must not yank a photo away to show a fault');
  console.log('[test] fault page behaviour');
}

console.log('[dev-viewstate-test] PASS');
