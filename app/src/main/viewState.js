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
    // The page launcher replaced the tab bar. Open/closed is STATE, not a
    // renderer detail: phase 4 drives a second surface from this same
    // snapshot, and a launcher open in the DOM of one window would be
    // invisible to the other.
    launcherOpen: false,
    chromeHidden: false,
    focused: true,
    autoShow: true,
    locale: 'en', // display language; both renderers translate through it
    banner: null, // { who, count, switched, at } — at keys the renderer's dismiss timer

    // Brief mode. See design/brief-mode/HANDOFF.md.
    //
    // `following` is default-ON and is what makes this usable at all: many
    // pilots see the EFB only through OpenKneeboard and cannot click
    // anything, so a consent prompt would be a wall rather than a control.
    // Paging away — keys they already use — leaves the brief; FOLLOW rejoins.
    //
    // `tool` lives here rather than in the renderer for the same reason
    // everything else does: phase 4 drives a second surface from this same
    // snapshot, and a tool selected in one DOM would be invisible to the
    // other.
    brief: {
      presenting: false, // this instance is driving the brief
      presenter: null, // callsign driving it, ours or someone else's
      focusHash: null, // the image the presenter is on
      following: true, // we snap to the presenter's page
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
    noteInteraction();
    const at = indexOfCurrent(q);
    const from = at === -1 ? Math.min(state.lastIdx, q.length - 1) : at;
    const i = (from + delta + q.length) % q.length;
    state.current = { batchId: q[i].batchId, filename: q[i].filename };
    state.lastIdx = i;
    // Paging away IS how you leave a brief. There is no BREAK requirement and
    // no dialog, because a pilot watching through OpenKneeboard cannot click
    // one — the chevrons and the next/prev hotkeys are controls they already
    // have. A presenter paging is not leaving: they ARE the page.
    if (state.brief.following && state.brief.presenter && !state.brief.presenting) {
      state.brief.following = false;
    }
  }

  // -------------------------------------------------------------------------
  // Brief mode
  // -------------------------------------------------------------------------

  /** This instance starts or stops driving the brief. */
  function setPresenting(on, callsign = state.callsign) {
    state.brief.presenting = Boolean(on);
    if (on) {
      state.brief.presenter = callsign || '';
      state.brief.following = true; // you cannot page away from yourself
    } else if (state.brief.presenter === (callsign || '')) {
      state.brief.presenter = null;
      state.brief.cursor = null;
    }
  }

  /** Someone else started or stopped presenting. */
  function setPresenter(callsign) {
    const had = state.brief.presenter;
    state.brief.presenter = callsign || null;
    if (!callsign) {
      state.brief.cursor = null;
      state.brief.focusHash = null;
      state.brief.presenting = false;
    }
    // A NEW brief starts with you in it. Re-following on every FOCUS would
    // undo a deliberate page-away on the presenter's next page turn.
    if (callsign && callsign !== had) state.brief.following = true;
  }

  /** The presenter moved to an image. Only moves us if we are following. */
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
    if (!state.brief.following || state.brief.presenting) return false;
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

  /** FOLLOW / REJOIN. Deliberately does NOT note an interaction: rejoining is
   *  asking to be moved, and the arrival grace would fight that. */
  function setFollowing(on) {
    state.brief.following = Boolean(on);
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
  /** Switching page always closes the launcher: it is a way to get somewhere,
   *  never a thing you leave open over the page you just chose. */
  function setPage(page) {
    noteInteraction();
    state.page = page;
    state.launcherOpen = false;
  }
  function setLauncher(open) {
    noteInteraction();
    state.launcherOpen = Boolean(open);
  }
  function toggleLauncher() {
    setLauncher(!state.launcherOpen);
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
      launcherOpen: state.launcherOpen,
      chromeHidden: state.chromeHidden,
      focused: state.focused,
      autoShow: state.autoShow,
      locale: state.locale,
      banner: state.banner,
      brief: {
        ...state.brief,
        // A brief is live when someone is presenting AND we have not paged
        // away from them. The renderer needs the distinction: "browsing on
        // your own" still shows who is presenting and offers REJOIN.
        live: Boolean(state.brief.presenter) && state.brief.following,
        // Following, but the image they are on is not in our queue. Silently
        // showing a different photo from everyone else is the worst possible
        // outcome in a brief, so this is stated.
        focusMissing:
          Boolean(state.brief.focusHash) &&
          !state.brief.presenting &&
          state.brief.following &&
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
    setFollowing,
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
    setLauncher,
    toggleLauncher,
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
