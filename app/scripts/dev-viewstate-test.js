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

  console.log('[test] launcher: toggle, closes on pick, arms grace');
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

// --- Losing the relay never changes the page ---------------------------------
// It used to take the screen. Replacing a photo the pilot is reading with an
// error card cost more than it told them, and the queue is local: browsing and
// sharing keep working while the relay is down.
{
  const { view } = withClock();
  view.setConnection({ connected: false, relayLabel: 'gab-pc' });
  assert.strictEqual(view.state.page, 'brief', 'a dead relay does not take the screen');
  assert.strictEqual(view.snapshot().connected, false, 'but the snapshot says so, for the fault bar');

  view.setPage('share');
  view.setConnection({ connected: false });
  assert.strictEqual(view.state.page, 'share', 'and it does not interrupt what you were doing');

  view.setLauncher(true);
  view.setConnection({ connected: false });
  assert.strictEqual(view.snapshot().launcherOpen, true, 'nor close the launcher');

  view.setConnection({ connected: true });
  assert.strictEqual(view.state.page, 'share', 'recovery does not move you either');
  console.log('[test] a dead relay is reported, never navigated to');
}


// ---------------------------------------------------------------------------
// FOCUS resolves by CONTENT HASH, never by the presenter's batchId.
//
// This shipped broken in v0.8.0 and it was as bad as it gets: the moment
// anyone pressed PRESENT, every OTHER pilot's kneeboard went to STANDBY. The
// cause is that `nextBatchId` is a per-instance counter starting at 1, so the
// presenter's "batch 3" names a different batch on every other machine — and
// pointing `current` at one that does not exist here makes indexOfCurrent
// return -1 and the stage go empty.
// ---------------------------------------------------------------------------
{
  const host = createViewState();
  const pilot = createViewState();

  host.addBatch({ sharedBy: 'GHOST', items: [{ filename: 'a.jpg', url: 'u1', hash: 'h-a' }] });

  // The pilot received an unrelated batch first, so their local ids differ.
  pilot.addBatch({ sharedBy: 'JOKER', items: [{ filename: 'other.jpg', url: 'u0', hash: 'h-other' }] });
  pilot.addBatch({ sharedBy: 'GHOST', items: [{ filename: 'a.jpg', url: 'u1', hash: 'h-a' }] });

  const hostBatchId = host.snapshot().queue.current.batchId;
  const pilotBatchId = pilot.snapshot().batches.find((b) => b.sharedBy === 'GHOST').id;
  assert.notStrictEqual(hostBatchId, pilotBatchId, 'the two instances must disagree, or this proves nothing');

  pilot.setPresenter('GHOST');
  // Exactly what main sends: the presenter's own local coordinates, plus the
  // hash. Only the hash may be trusted.
  pilot.setFocus({ hash: 'h-a', batchId: String(hostBatchId), filename: 'a.jpg' });

  const shown = pilot.snapshot().queue.current;
  assert.ok(shown, 'the follower must NOT go to STANDBY when the presenter picks a photo');
  assert.strictEqual(shown.filename, 'a.jpg', 'and must land on the same photo');
  assert.strictEqual(shown.batchId, pilotBatchId, 'resolved into the follower\'s OWN batch id');
  assert.strictEqual(pilot.snapshot().brief.focusMissing, false);

  // A photo the follower does not have: keep their page, and say so.
  pilot.setFocus({ hash: 'h-never-seen' });
  assert.ok(pilot.snapshot().queue.current, 'an unknown photo must not blank the kneeboard');
  assert.strictEqual(pilot.snapshot().queue.current.filename, 'a.jpg', 'the page is left alone');
  assert.strictEqual(pilot.snapshot().brief.focusMissing, true, 'and the pilot is told they are out of step');

  // A presenter never follows their own FOCUS.
  const solo = createViewState();
  solo.addBatch({ sharedBy: 'ME', items: [{ filename: 'x.jpg', url: 'u', hash: 'h-x' }, { filename: 'y.jpg', url: 'u2', hash: 'h-y' }] });
  solo.setPresenting(true, 'ME');
  solo.step(1);
  const before = solo.snapshot().queue.current.filename;
  solo.setFocus({ hash: 'h-x' });
  assert.strictEqual(solo.snapshot().queue.current.filename, before, 'a presenter is not moved by their own focus');
  console.log('[test] FOCUS resolves by content hash across instances, never by batch id');
}

// --- a follower's view belongs to the presenter ------------------------------
// A brief where each pilot can wander off is not a brief. While someone else
// presents, every local control that would move the view is refused, and the
// only ways out are the presenter stopping or vanishing.
{
  const pilot = createViewState();
  pilot.addBatch({
    sharedBy: 'GHOST',
    items: [
      { filename: 'a.jpg', url: 'u1', hash: 'h-a' },
      { filename: 'b.jpg', url: 'u2', hash: 'h-b' },
    ],
  });

  // Free to move before anyone presents.
  pilot.step(1);
  assert.strictEqual(pilot.snapshot().queue.current.filename, 'b.jpg', 'paging works when no brief is running');
  pilot.setPage('share');
  assert.strictEqual(pilot.snapshot().page, 'share');
  pilot.setPage('brief');

  pilot.setPresenter('GHOST');
  assert.strictEqual(pilot.snapshot().brief.locked, true, 'a foreign presenter holds our controls');

  const held = pilot.snapshot().queue.current.filename;
  pilot.step(1);
  assert.strictEqual(pilot.snapshot().queue.current.filename, held, 'paging is refused while following');
  pilot.step(-1);
  assert.strictEqual(pilot.snapshot().queue.current.filename, held, 'in both directions');

  pilot.setPage('setup');
  assert.strictEqual(pilot.snapshot().page, 'brief', 'the page is held too — no wandering into menus');
  pilot.setLauncher(true);
  assert.strictEqual(pilot.snapshot().launcherOpen, false, 'and the launcher will not open');

  // The presenter still moves us. That is the entire point of the lock.
  pilot.setFocus({ hash: 'h-a' });
  assert.strictEqual(pilot.snapshot().queue.current.filename, 'a.jpg', 'the presenter moves the follower');
  pilot.setFocus({ hash: 'h-b' });
  assert.strictEqual(pilot.snapshot().queue.current.filename, 'b.jpg', 'every page turn, not just the first');

  // Release 1: the presenter stops.
  pilot.setPresenter(null);
  assert.strictEqual(pilot.snapshot().brief.locked, false, 'stopping hands the controls back');
  pilot.step(-1);
  assert.strictEqual(pilot.snapshot().queue.current.filename, 'a.jpg', 'and paging works again');
  pilot.setPage('setup');
  assert.strictEqual(pilot.snapshot().page, 'setup', 'as does leaving the page');

  // Release 2: the presenter vanished. main clears the presenter when our own
  // link drops, which is the same call — assert it from a locked state, since
  // being stuck behind a stale lock is the failure that would matter.
  pilot.setPresenter('GHOST');
  assert.strictEqual(pilot.snapshot().brief.locked, true);
  pilot.setPresenter(null);
  assert.strictEqual(pilot.snapshot().brief.locked, false, 'a vanished presenter must never hold a pilot');

  // A presenter is never locked out of their own controls.
  const boss = createViewState();
  boss.addBatch({
    sharedBy: 'ME',
    items: [
      { filename: 'x.jpg', url: 'u', hash: 'h-x' },
      { filename: 'y.jpg', url: 'u2', hash: 'h-y' },
    ],
  });
  boss.setPresenting(true, 'ME');
  assert.strictEqual(boss.snapshot().brief.locked, false, 'presenting is not being followed');
  const at = boss.snapshot().queue.current.filename;
  boss.step(1);
  assert.notStrictEqual(boss.snapshot().queue.current.filename, at, 'the presenter pages freely');
  boss.setPage('share');
  assert.strictEqual(boss.snapshot().page, 'share', 'and reaches every page');
  console.log('[test] a follower is held in the brief; presenter stop or vanish releases them');
}

console.log('[dev-viewstate-test] PASS');
