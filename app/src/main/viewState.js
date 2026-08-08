'use strict';

// THE single source of truth for everything both windows render.
//
// ROADMAP §5.2: the renderer owns no state. Phase 4 renders this same HTML
// offscreen into an OpenXR quad layer, possibly alongside the desktop window
// — state living only in one DOM cannot be shared between two surfaces. So
// main holds it all and pushes complete snapshots; a renderer is a pure
// function of what it is given, and sends back intents, never decisions.
//
// Practically that means: no `let currentIndex` in viewer.js. Which photo is
// on the stage, what is selected for sharing, what is hidden from the brief —
// all of it lives here.
//
// v0.4 model: BRIEF is the kneeboard. All received photos form ONE flat
// queue, newest batch first; an arrival PREPENDS. RECEIVED does not "open"
// batches any more — it curates the queue: every item carries `selected`,
// and deselected items are simply not in it. There is no unread state and no
// badge; the banner announces every arrival instead.
//
// Pure Node, no Electron: unit-testable, and the push side is injected.

const DEFAULT_MAX_BATCHES = 25;

// BRIEF §2, "the auto-switch conflict". Ship rule C: switch on arrival unless
// the pilot interacted in the last 8s, so a reveal can't yank the page out
// from under someone mid-read.
const INTERACTION_GRACE_MS = 8000;

function createViewState({ maxBatches = DEFAULT_MAX_BATCHES, now = () => Date.now() } = {}) {
  const state = {
    // identity / net
    callsign: '',
    isHost: false,
    connected: false,
    peers: [],
    relayLabel: '',
    lastContactAt: null,
    reconnect: null, // { attempt, nextInMs } while down

    // viewer
    page: 'brief',
    // Navigation is a rail, not a menu. Collapsed/open is STATE, not a
    // renderer detail: phase 4 drives a second surface from this same
    // snapshot, and a rail collapsed in one window would be invisible to the
    // other.
    // The grid launcher is gone; navigation is a permanent rail. What is
    // stateful now is whether the pilot has COLLAPSED it — default open,
    // because one press to anywhere is the whole point.
    navCollapsed: false,
    chromeHidden: false,
    focused: true,
    autoShow: true,
    locale: 'en', // display language; both renderers translate through it
    banner: null, // { who, count, switched, at } — at keys the renderer's dismiss timer

    // Brief mode. See design/brief-mode/HANDOFF.md.
    //
    // Following is not a flag any more: while someone else presents you follow
    // them, full stop, and `isFollower()` derives it. It used to be an opt-out
    // a pilot left by paging away, on the reasoning that many see the EFB only
    // through OpenKneeboard and cannot click a consent dialog. That reasoning
    // was about not requiring a CLICK TO JOIN, and it survives — what did not
    // is letting a follower drift: the presenter says "look at this" and had
    // no way to know who still was.
    //
    // `tool` lives here rather than in the renderer for the same reason
    // everything else does: phase 4 drives a second surface from this same
    // snapshot, and a tool selected in one DOM would be invisible to the
    // other.
    brief: {
      presenting: false, // this instance is driving the brief
      presenter: null, // callsign driving it, ours or someone else's
      focusHash: null, // the image the presenter is on
      tool: 'pen', // pen | arrow | ring
      cursor: null, // { u, v, who } — the presenter's pointer, 20 Hz
      inkRevs: {}, // hash -> revision; the ONLY ink that rides the snapshot
    },

    // received — the queue's backing store.
    // newest first: { id, sharedBy, receivedAt, items:[{filename, url, selected}] }
    batches: [],
    // What is on the stage, by IDENTITY, not index: deselecting some other
    // photo must never change what is on the pilot's knee. null = STANDBY.
    current: null, // { batchId, filename }
    // Where identity last was in the queue — the repair target when the
    // current photo itself is dropped: fall to the same position, which is
    // the next photo. Clamped, so dropping the last falls to the new last.
    lastIdx: 0,

    // share
    folder: '',
    photos: [], // { filename, selected, thumbUrl }
    stagedBytes: 0,
    profile: 'kneeboard',

    // tailscale / funnel
    funnel: null,

    // diagnostics
    counters: { sent: 0, received: 0, drops: 0 },
    logPath: '',
    version: '',
  };

  let nextBatchId = 1;
  let lastInteractionAt = 0;

  // -- interaction clock ----------------------------------------------------
  /** Any deliberate act by the pilot: paging, curating, switching tab. */
  function noteInteraction() {
    lastInteractionAt = now();
  }
  function recentlyInteracted() {
    return now() - lastInteractionAt <= INTERACTION_GRACE_MS;
  }

  // -- the queue ------------------------------------------------------------
  /** The flat photo queue BRIEF pages through: newest batch first, batch
   *  order preserved inside, deselected items skipped. */
  function queue() {
    const flat = [];
    for (const b of state.batches) {
      for (const item of b.items) {
        if (item.selected) {
          flat.push({
            batchId: b.id,
            filename: item.filename,
            url: item.url,
            // Brief-mode ink is keyed by this, never by filename — a
            // re-shared file with the same name must show no foreign ink
            // rather than the wrong ink.
            hash: item.hash || null,
            sharedBy: b.sharedBy,
            receivedAt: b.receivedAt,
          });
        }
      }
    }
    return flat;
  }

  function indexOfCurrent(q) {
    if (!state.current) return -1;
    return q.findIndex(
      (p) => p.batchId === state.current.batchId && p.filename === state.current.filename,
    );
  }

  /** Re-anchors `current` after anything that changed the queue. Identity
   *  wins; a dropped identity falls to the same position (= the next photo,
   *  clamped so dropping the last falls to the new last). */
  function repairCurrent() {
    const q = queue();
    if (q.length === 0) {
      state.current = null;
      state.lastIdx = 0;
      return;
    }
    let i = indexOfCurrent(q);
    if (i === -1) {
      i = Math.min(state.lastIdx, q.length - 1);
      state.current = { batchId: q[i].batchId, filename: q[i].filename };
    }
    state.lastIdx = i;
  }

  // -- received -------------------------------------------------------------
  /**
   * Records an arriving batch at the FRONT of the queue. Returns
   * { entry, switched } — `switched` is rule C's verdict. The banner shows for
   * every arrival (there is no badge): when it switched it must say so — a
   * page that moves on its own without saying why reads as a bug — and when
   * it did not, the banner is the only trace the arrival leaves.
   */
  function addBatch({ sharedBy, items, receivedAt = now() }) {
    const entry = {
      id: nextBatchId++,
      sharedBy: sharedBy || '',
      receivedAt,
      items: (items || []).map((item) => ({ filename: item.filename, url: item.url, hash: item.hash || null, selected: true })),
    };
    state.batches.unshift(entry);
    if (state.batches.length > maxBatches) state.batches.length = maxBatches;

    const switched = state.autoShow && !recentlyInteracted() && entry.items.length > 0;
    if (switched) {
      // The new intel takes the stage at 1/N.
      state.current = { batchId: entry.id, filename: entry.items[0].filename };
      state.lastIdx = 0;
      state.page = 'brief';
    } else if (state.current === null && entry.items.length > 0) {
      // Nothing on the stage yet: adopt it silently so paging has something,
      // but leave the page alone.
      state.current = { batchId: entry.id, filename: entry.items[0].filename };
      state.lastIdx = 0;
    }
    // Any arrival supersedes the previous banner; `at` keys the renderer's
    // auto-dismiss timer so a later state push cannot extend an old banner.
    state.banner = { who: entry.sharedBy, count: entry.items.length, switched, at: now() };
    repairCurrent(); // eviction may have dropped the batch `current` was in
    state.counters.received += 1;
    return { entry, switched };
  }

  /** Pages the flat queue. Wraps: one step back from the newest photo is the
   *  oldest — with a hotkey in flight that beats a dead stop. */
  function step(delta) {
    const q = queue();
    if (q.length === 0) return;
    if (isFollower()) return; // the presenter owns the page — see isFollower
    noteInteraction();
    const at = indexOfCurrent(q);
    const from = at === -1 ? Math.min(state.lastIdx, q.length - 1) : at;
    const i = (from + delta + q.length) % q.length;
    state.current = { batchId: q[i].batchId, filename: q[i].filename };
    state.lastIdx = i;
  }

  // -------------------------------------------------------------------------
  // Brief mode
  // -------------------------------------------------------------------------

  /**
   * True when someone ELSE is presenting: this instance is a follower, and its
   * view belongs to the presenter for the duration.
   *
   * While this holds, every local control that would move the view is refused
   * — paging, changing page, collapsing the rail. A brief where each pilot
   * can wander off is not a brief: the presenter says "look at this" and has
   * no way to know who actually is. Nothing here is a permission model; a
   * follower simply has nothing to decide until the cast ends.
   *
   * There is deliberately NO manual escape, so the two automatic releases are
   * the whole safety story and both must keep working:
   *   1. the presenter stops — `brief-present-stop`, fanned out to everyone;
   *   2. the presenter vanishes — the relay notices the socket close and fans
   *      out the same stop on their behalf (relayServer.js), and if it is OUR
   *      link that dropped, index.js clears the presenter locally. On
   *      reconnect the relay re-announces the live brief, so a blip re-locks
   *      rather than stranding anyone outside it.
   * Being stuck behind a stale lock is the failure that would matter here, so
   * a release is never conditional on a message we might have missed.
   */
  function isFollower() {
    return Boolean(state.brief.presenter) && !state.brief.presenting;
  }

  /** This instance starts or stops driving the brief. */
  function setPresenting(on, callsign = state.callsign) {
    state.brief.presenting = Boolean(on);
    if (on) {
      state.brief.presenter = callsign || '';
    } else if (state.brief.presenter === (callsign || '')) {
      state.brief.presenter = null;
      state.brief.cursor = null;
    }
  }

  /** Someone else started or stopped presenting. */
  function setPresenter(callsign) {
    state.brief.presenter = callsign || null;
    if (!callsign) {
      state.brief.cursor = null;
      state.brief.focusHash = null;
      state.brief.presenting = false;
    }
  }

  /** The presenter moved to an image. Moves us unless we are the presenter. */
  /**
   * The presenter moved to an image. Resolved by CONTENT HASH, never by the
   * batchId and filename the message also carries.
   *
   * Those are the presenter's LOCAL coordinates: `nextBatchId` is a per-
   * instance counter starting at 1, so their batch 3 and ours are unrelated.
   * Setting `current` from them pointed at a photo that does not exist here,
   * `indexOfCurrent` returned -1, `queue.current` became null — and every
   * following pilot's kneeboard went to STANDBY the instant someone pressed
   * PRESENT. The hash is the only identifier that means the same thing on two
   * machines, which is exactly why ink is keyed by it too.
   */
  function setFocus({ hash }) {
    state.brief.focusHash = hash || null;
    // No `following` test any more: a follower cannot page away, so it could
    // only ever be true. The presenter is the one instance that ignores this,
    // because they are already on the image they just announced.
    if (state.brief.presenting) return false;
    if (!hash) return false;
    const q = queue();
    const at = q.findIndex((p) => p.hash === hash);
    // We may simply not have this photo: joined after it was shared, or
    // curated it out of our own brief. Leave the page alone — blanking a
    // pilot's kneeboard is worse than showing them the previous photo, and
    // `focusMissing` in the snapshot lets the UI say so out loud.
    if (at === -1) return false;
    state.current = { batchId: q[at].batchId, filename: q[at].filename };
    state.lastIdx = at;
    return true;
  }

  function setTool(tool) {
    if (tool !== 'pen' && tool !== 'arrow' && tool !== 'ring') return;
    noteInteraction();
    state.brief.tool = tool;
  }

  function setCursor(cursor) {
    state.brief.cursor = cursor || null;
  }

  /** hash -> revision, so a renderer can spot a gap and ask for the full set.
   *  This is the only ink that rides the 3-second state push. */
  function setInkRevs(revs) {
    state.brief.inkRevs = revs || {};
  }

  /** RECEIVED curation: drop or restore one photo in the brief. */
  function toggleItem(batchId, filename) {
    const batch = state.batches.find((b) => b.id === batchId);
    const item = batch && batch.items.find((it) => it.filename === filename);
    if (!item) return null;
    noteInteraction();
    item.selected = !item.selected;
    repairCurrent();
    return item;
  }

  /** RECEIVED curation: HIDE / RESTORE a whole batch. */
  function setBatchSelected(batchId, selected) {
    const batch = state.batches.find((b) => b.id === batchId);
    if (!batch) return null;
    noteInteraction();
    for (const item of batch.items) item.selected = Boolean(selected);
    repairCurrent();
    return batch;
  }

  // -- viewer chrome --------------------------------------------------------
  /** Switching page. The rail stays as the pilot left it — it is navigation,
   *  not a menu, so there is nothing to close on arrival. */
  function setPage(page) {
    if (isFollower()) return; // held on the presenter's page
    noteInteraction();
    state.page = page;
  }
  function setNavCollapsed(collapsed) {
    noteInteraction();
    state.navCollapsed = Boolean(collapsed);
  }
  function toggleNav() {
    noteInteraction();
    state.navCollapsed = !state.navCollapsed;
  }
  function toggleChrome() {
    state.chromeHidden = !state.chromeHidden;
  }
  function setFocused(focused) {
    state.focused = focused;
    if (focused) noteInteraction();
  }
  function clearBanner() {
    state.banner = null;
  }

  // -- share ----------------------------------------------------------------
  function setGallery({ folder, photos }) {
    state.folder = folder || '';
    state.photos = photos || [];
  }
  function togglePhoto(filename) {
    noteInteraction();
    const photo = state.photos.find((p) => p.filename === filename);
    if (photo) photo.selected = !photo.selected;
  }
  function setAllSelected(selected) {
    noteInteraction();
    for (const photo of state.photos) photo.selected = selected;
  }
  function selectedFilenames() {
    return state.photos.filter((p) => p.selected).map((p) => p.filename);
  }

  // -- net ------------------------------------------------------------------
  function setConnection({ connected, relayLabel, reconnect }) {
    state.connected = connected;
    if (relayLabel !== undefined) state.relayLabel = relayLabel;
    state.reconnect = connected ? null : reconnect || state.reconnect;
    if (connected) state.lastContactAt = now();
    // The relay going down NO LONGER changes the page. It used to take the
    // whole screen, which meant an error card replaced a photo the pilot was
    // reading — and losing the relay does not lose the intel already
    // received: the queue is local, and browsing and sharing still work. It
    // is reported in place by the fault bar, which is chrome and therefore
    // stays out of the capture.
  }

  /** The snapshot pushed to renderers. Everything derived is computed here so
   *  a renderer never has to decide anything. */
  function snapshot() {
    const q = queue();
    const i = indexOfCurrent(q);
    return {
      callsign: state.callsign,
      isHost: state.isHost,
      connected: state.connected,
      peers: state.peers,
      relayLabel: state.relayLabel,
      lastContactAt: state.lastContactAt,
      reconnect: state.reconnect,

      page: state.page,
      navCollapsed: state.navCollapsed,
      chromeHidden: state.chromeHidden,
      focused: state.focused,
      autoShow: state.autoShow,
      locale: state.locale,
      banner: state.banner,
      brief: {
        ...state.brief,
        // A brief is live whenever anyone is presenting. There is no longer a
        // "watching but browsing on my own" state to distinguish it from.
        live: Boolean(state.brief.presenter),
        // Our controls are held by the presenter. The renderer needs this to
        // say so out loud — chrome that silently stops responding reads as a
        // frozen app, which is worse than being told who has the stick.
        locked: isFollower(),
        // Following, but the image they are on is not in our queue. Silently
        // showing a different photo from everyone else is the worst possible
        // outcome in a brief, so this is stated.
        focusMissing:
          Boolean(state.brief.focusHash) &&
          isFollower() &&
          !q.some((p) => p.hash === state.brief.focusHash),
      },

      queue: {
        total: q.length,
        pos: i, // 0-based; -1 only when the queue is empty
        current: i === -1 ? null : q[i],
      },
      batches: state.batches.map((b) => ({
        id: b.id,
        sharedBy: b.sharedBy,
        receivedAt: b.receivedAt,
        count: b.items.length,
        selectedCount: b.items.filter((it) => it.selected).length,
        items: b.items.map((it) => ({ filename: it.filename, url: it.url, hash: it.hash || null, selected: it.selected })),
      })),

      folder: state.folder,
      photos: state.photos,
      selectedCount: state.photos.filter((p) => p.selected).length,
      photoCount: state.photos.length,
      stagedBytes: state.stagedBytes,
      profile: state.profile,

      funnel: state.funnel,
      counters: state.counters,
      logPath: state.logPath,
      version: state.version,
    };
  }

  return {
    state,
    snapshot,
    setPresenting,
    setPresenter,
    setFocus,
    isFollower,
    setTool,
    setCursor,
    setInkRevs,
    noteInteraction,
    recentlyInteracted,
    queue,
    addBatch,
    step,
    toggleItem,
    setBatchSelected,
    setPage,
    setNavCollapsed,
    toggleNav,
    toggleChrome,
    setFocused,
    clearBanner,
    setGallery,
    togglePhoto,
    setAllSelected,
    selectedFilenames,
    setConnection,
  };
}

module.exports = { createViewState, INTERACTION_GRACE_MS, DEFAULT_MAX_BATCHES };
