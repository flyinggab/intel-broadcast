'use strict';

// Unit test for viewState.js — the main-process store that both windows are a
// pure function of (ROADMAP §5.2). Covers the auto-switch rule (rule C) and
// the v0.4 queue model: one flat photo queue, newest batch first, curated
// from RECEIVED, with the stage tracking photo IDENTITY rather than an index.
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

const cur = (view) => view.snapshot().queue.current;

// --- Rule C: switch on arrival when the pilot is idle -----------------------
{
  const { view } = withClock();
  const { switched } = view.addBatch({ sharedBy: 'alpha', items: items(3) });
  assert.strictEqual(switched, true, 'idle pilot: arrival takes the screen');
  assert.strictEqual(view.state.page, 'brief', 'BRIEF is the kneeboard now');
  assert.strictEqual(view.snapshot().banner.switched, true, 'a switch MUST be announced');
  assert.strictEqual(view.snapshot().queue.total, 3);
  assert.strictEqual(view.snapshot().queue.pos, 0, 'arrival lands at 1/N');
  assert.strictEqual(cur(view).filename, '0.jpg');
  console.log('[test] rule C: idle -> switches to the front of the queue and says so');
}

// --- Rule C: do NOT switch within the grace window --------------------------
{
  const { view, advance } = withClock();
  view.addBatch({ sharedBy: 'alpha', items: items(2) }); // seeds the stage
  view.step(1); // the pilot is reading — now on alpha's second photo
  advance(INTERACTION_GRACE_MS - 1000);

  const before = cur(view);
  const { switched } = view.addBatch({ sharedBy: 'bravo', items: items(4) });
  assert.strictEqual(switched, false, 'must not yank the page out from under a reader');
  const snap = view.snapshot();
  assert.ok(snap.banner, 'with no badge, the banner is the only trace — it must show');
  assert.strictEqual(snap.banner.switched, false, 'and it must not claim it switched');
  assert.strictEqual(snap.queue.total, 6, 'the queue still grew');
  assert.deepStrictEqual(cur(view), { ...before }, 'what is on the stage did not move');
  assert.strictEqual(snap.queue.pos, 5, 'prepend renumbers: same photo, later position');
  console.log('[test] rule C: recent interaction -> queued with a banner, stage held still');
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

// --- The escape hatch in settings -------------------------------------------
{
  const { view } = withClock();
  view.state.autoShow = false;
  const { switched } = view.addBatch({ sharedBy: 'alpha', items: items(2) });
  assert.strictEqual(switched, false, 'SHOW NEW INTEL ON ARRIVAL off means never switch');
  assert.ok(view.snapshot().banner, 'still announced');
  assert.strictEqual(view.snapshot().banner.switched, false);
  assert.strictEqual(cur(view).filename, '0.jpg', 'empty stage adopts silently');
  console.log('[test] auto-show toggle defeats switching entirely');
}

// --- Banner identity: each arrival restamps `at` ----------------------------
// The renderer keys its 10s auto-dismiss timer on banner.at; if two arrivals
// carried the same stamp the second banner would inherit the first's timer.
{
  const { view, advance } = withClock();
  view.addBatch({ sharedBy: 'alpha', items: items(1) });
  const first = view.snapshot().banner.at;
  advance(1234);
  view.addBatch({ sharedBy: 'bravo', items: items(1) });
  assert.notStrictEqual(view.snapshot().banner.at, first, 'a new arrival restamps the banner');
  console.log('[test] banner.at restamps per arrival');
}

// --- Paging wraps across the WHOLE queue, not within a batch ----------------
{
  const { view, advance } = withClock();
  view.addBatch({ sharedBy: 'old', items: items(2) });
  advance(INTERACTION_GRACE_MS + 1);
  view.addBatch({ sharedBy: 'new', items: items(2) });
  // queue: new/0 new/1 old/0 old/1 — current new/0
  view.step(-1);
  const wrapped = cur(view);
  assert.strictEqual(wrapped.sharedBy, 'old', 'one step back from the front is the oldest');
  assert.strictEqual(wrapped.filename, '1.jpg');
  assert.strictEqual(view.snapshot().queue.pos, 3);
  view.step(1);
  assert.strictEqual(view.snapshot().queue.pos, 0, 'wraps forward again');
  console.log('[test] paging wraps across the flat queue');
}

// --- Curation: dropping another photo never moves the stage -----------------
{
  const { view, advance } = withClock();
  const a = view.addBatch({ sharedBy: 'alpha', items: items(3) }).entry;
  advance(INTERACTION_GRACE_MS + 1);
  const b = view.addBatch({ sharedBy: 'bravo', items: items(2) }).entry;
  // queue: b0 b1 a0 a1 a2 — current b0
  view.step(1); // -> b1 (pos 1)
  const before = cur(view);

  view.toggleItem(a.id, '1.jpg'); // drop a photo BEHIND the stage
  assert.deepStrictEqual(cur(view), { ...before }, 'stage identity unchanged');
  assert.strictEqual(view.snapshot().queue.total, 4);
  assert.strictEqual(view.snapshot().queue.pos, 1, 'position unchanged too');

  view.toggleItem(b.id, '0.jpg'); // drop a photo AHEAD of the stage
  assert.deepStrictEqual(cur(view), { ...before }, 'still unchanged');
  assert.strictEqual(view.snapshot().queue.pos, 0, 'renumbered, not moved');
  console.log('[test] curation: dropping other photos never moves the stage');
}

// --- Curation: dropping the CURRENT photo advances in place -----------------
{
  const { view } = withClock();
  const a = view.addBatch({ sharedBy: 'alpha', items: items(3) }).entry;
  // current a0 at pos 0
  view.toggleItem(a.id, '0.jpg');
  assert.strictEqual(cur(view).filename, '1.jpg', 'falls to the same position = the next photo');
  assert.strictEqual(view.snapshot().queue.pos, 0);

  // dropping the LAST photo falls back to the new last
  view.step(1); // -> a2 (pos 1 of [a1 a2])
  view.toggleItem(a.id, '2.jpg');
  assert.strictEqual(cur(view).filename, '1.jpg', 'dropping the last clamps backward');

  // restore brings it back into the queue, stage does not jump
  view.toggleItem(a.id, '2.jpg');
  assert.strictEqual(cur(view).filename, '1.jpg');
  assert.strictEqual(view.snapshot().queue.total, 2);
  console.log('[test] curation: dropping the current photo advances in place');
}

// --- Curation: HIDE / RESTORE a whole batch ---------------------------------
{
  const { view, advance } = withClock();
  const a = view.addBatch({ sharedBy: 'alpha', items: items(2) }).entry;
  advance(INTERACTION_GRACE_MS + 1);
  const b = view.addBatch({ sharedBy: 'bravo', items: items(1) }).entry;
  // current b0
  view.setBatchSelected(b.id, false); // hide the batch the stage is in
  assert.strictEqual(cur(view).sharedBy, 'alpha', 'stage falls into the surviving batch');
  assert.strictEqual(view.snapshot().queue.total, 2);

  view.setBatchSelected(a.id, false); // hide everything
  assert.strictEqual(view.snapshot().queue.total, 0);
  assert.strictEqual(view.snapshot().queue.current, null, 'empty queue = STANDBY');

  view.setBatchSelected(a.id, true); // restore
  assert.strictEqual(view.snapshot().queue.total, 2);
  assert.ok(cur(view), 'stage re-anchors after restore');
  assert.strictEqual(view.setBatchSelected(9999, true), null, 'unknown id is a no-op');
  console.log('[test] curation: batch hide/restore with stage repair');
}

// --- Per-batch selection counts reach the snapshot --------------------------
{
  const { view } = withClock();
  const a = view.addBatch({ sharedBy: 'alpha', items: items(3) }).entry;
  view.toggleItem(a.id, '1.jpg');
  const snap = view.snapshot().batches[0];
  assert.strictEqual(snap.count, 3);
  assert.strictEqual(snap.selectedCount, 2);
  assert.deepStrictEqual(snap.items.map((it) => it.selected), [true, false, true]);
  console.log('[test] snapshot carries per-batch selection for RECEIVED');
}

// --- Eviction keeps the newest and repairs the stage ------------------------
{
  let t = 1_000_000;
  const view = createViewState({ maxBatches: 2, now: () => t });
  view.addBatch({ sharedBy: 'a', items: items(1) });
  t += INTERACTION_GRACE_MS + 1;
  view.addBatch({ sharedBy: 'b', items: items(1) });
  view.step(1); // wrap onto a's photo (pos 1)
  t += INTERACTION_GRACE_MS + 1;
  view.addBatch({ sharedBy: 'c', items: items(1) }); // evicts a — the batch on stage
  const snap = view.snapshot();
  assert.deepStrictEqual(snap.batches.map((b) => b.sharedBy), ['c', 'b'], 'caps and drops the oldest');
  assert.ok(snap.queue.current, 'stage survives its batch being evicted');
  assert.strictEqual(snap.queue.current.sharedBy, 'c', 'switched to the arrival that evicted it');
  console.log('[test] eviction caps history and repairs the stage');
}

// --- The page launcher -------------------------------------------------------
// It replaced the tab bar, and open/closed is main's state, not the renderer's.
{
  const { view } = withClock();
  assert.strictEqual(view.snapshot().launcherOpen, false, 'starts closed');

  view.toggleLauncher();
  assert.strictEqual(view.snapshot().launcherOpen, true);
  view.toggleLauncher();
  assert.strictEqual(view.snapshot().launcherOpen, false);

  view.setLauncher(true);
  assert.strictEqual(view.snapshot().launcherOpen, true);
  // Choosing a destination closes it: the launcher is a way to get somewhere,
  // never a thing left open on top of the page you just picked.
  view.setPage('share');
  assert.strictEqual(view.snapshot().page, 'share');
  assert.strictEqual(view.snapshot().launcherOpen, false, 'picking a page closes the launcher');

  // Opening it is a deliberate act, so it must arm the auto-switch grace
  // window — an arrival must not yank the page while the menu is open.
  const { view: v2, advance } = withClock();
  advance(INTERACTION_GRACE_MS + 1);
  v2.setLauncher(true);
  assert.strictEqual(v2.recentlyInteracted(), true, 'opening the launcher counts as interaction');
  const { switched } = v2.addBatch({ sharedBy: 'alpha', items: items(2) });
  assert.strictEqual(switched, false, 'an arrival must not switch the page under an open launcher');

  // A relay fault takes the screen — and must not leave a menu floating on
  // top of the alarm.
  const { view: v3 } = withClock();
  v3.setLauncher(true);
  v3.setConnection({ connected: false, relayLabel: 'gab-pc' });
  assert.strictEqual(v3.state.page, 'fault');
  assert.strictEqual(v3.snapshot().launcherOpen, false, 'FAULT closes the launcher');
  console.log('[test] launcher: toggle, closes on pick, arms grace, yields to FAULT');
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
  assert.strictEqual(view.state.page, 'fault', 'down with nothing on stage -> FAULT');
  view.setConnection({ connected: true });
  assert.strictEqual(view.state.page, 'brief', 'recovers off the fault page');

  view.addBatch({ sharedBy: 'alpha', items: items(1) }); // brief, queue live
  view.setConnection({ connected: false });
  assert.strictEqual(view.state.page, 'brief', 'must not yank a photo away to show a fault');

  view.setConnection({ connected: true });
  view.setPage('received');
  view.setConnection({ connected: false });
  assert.strictEqual(view.state.page, 'fault', 'not reading a photo -> FAULT may take over');
  console.log('[test] fault page behaviour');
}

console.log('[dev-viewstate-test] PASS');
