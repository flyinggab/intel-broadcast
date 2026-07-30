'use strict';

// THE single source of truth for everything both windows render.
//
// ROADMAP §5.2: the renderer owns no state. Phase 4 renders this same HTML
// offscreen into an OpenXR quad layer, possibly alongside the desktop window
// — state living only in one DOM cannot be shared between two surfaces. So
// main holds it all and pushes complete snapshots; a renderer is a pure
// function of what it is given, and sends back intents, never decisions.
//
// Practically that means: no `let currentIndex` in viewer.js. Which batch is
// open, which photo within it, what is selected for sharing, what is unread —
// all of it lives here.
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
    chromeHidden: false,
    focused: true,
    autoShow: true,
    banner: null, // { who, count, switched }

    // received
    batches: [], // newest first: { id, sharedBy, receivedAt, unread, items:[{filename,url}] }
    openBatchId: null,
    frameIndex: 0,

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
  /** Any deliberate act by the pilot: paging, tapping a row, switching tab. */
  function noteInteraction() {
    lastInteractionAt = now();
  }
  function recentlyInteracted() {
    return now() - lastInteractionAt <= INTERACTION_GRACE_MS;
  }

  // -- received -------------------------------------------------------------
  /**
   * Records an arriving batch. Returns { entry, switched } — `switched` is
   * rule C's verdict, and the caller must show the banner saying so when it
   * is true. A page that moves on its own without saying why reads as a bug.
   */
  function addBatch({ sharedBy, items, receivedAt = now() }) {
    const entry = {
      id: nextBatchId++,
      sharedBy: sharedBy || '',
      receivedAt,
      unread: true,
      items: (items || []).map((item) => ({ filename: item.filename, url: item.url })),
    };
    state.batches.unshift(entry);
    if (state.batches.length > maxBatches) state.batches.length = maxBatches;

    // Any arrival supersedes the previous banner: leaving an older one up
    // while a newer batch is only badged tells the pilot the wrong thing about
    // what is on screen.
    state.banner = null;

    const switched = state.autoShow && !recentlyInteracted();
    if (switched) {
      state.openBatchId = entry.id;
      state.frameIndex = 0;
      state.page = 'frame';
      entry.unread = false;
      state.banner = { who: entry.sharedBy, count: entry.items.length, switched: true };
    } else if (state.openBatchId === null) {
      // Nothing on the stage yet: adopt it silently so BROWSE has something,
      // but leave the page and the unread mark alone.
      state.openBatchId = entry.id;
      state.frameIndex = 0;
    }
    state.counters.received += 1;
    return { entry, switched };
  }

  function openBatch(id) {
    const entry = state.batches.find((b) => b.id === id);
    if (!entry) return null;
    noteInteraction();
    state.openBatchId = entry.id;
    state.frameIndex = 0;
    entry.unread = false;
    state.page = 'frame';
    return entry;
  }

  function openEntry() {
    return state.batches.find((b) => b.id === state.openBatchId) || null;
  }

  function step(delta) {
    const entry = openEntry();
    if (!entry || entry.items.length === 0) return;
    noteInteraction();
    entry.unread = false;
    state.frameIndex = (state.frameIndex + delta + entry.items.length) % entry.items.length;
  }

  function unreadCount() {
    return state.batches.reduce((n, b) => n + (b.unread ? 1 : 0), 0);
  }

  function markOpenRead() {
    const entry = openEntry();
    if (entry) entry.unread = false;
  }

  // -- viewer chrome --------------------------------------------------------
  function setPage(page) {
    noteInteraction();
    state.page = page;
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
    // FAULT owns the screen while the relay is down, but never steals it from
    // a photo the pilot is actually reading.
    if (!connected && state.page !== 'frame') state.page = 'fault';
    if (connected && state.page === 'fault') state.page = 'brief';
  }

  /** The snapshot pushed to renderers. Everything derived is computed here so
   *  a renderer never has to decide anything. */
  function snapshot() {
    const entry = openEntry();
    return {
      callsign: state.callsign,
      isHost: state.isHost,
      connected: state.connected,
      peers: state.peers,
      relayLabel: state.relayLabel,
      lastContactAt: state.lastContactAt,
      reconnect: state.reconnect,

      page: state.page,
      chromeHidden: state.chromeHidden,
      focused: state.focused,
      autoShow: state.autoShow,
      banner: state.banner,

      unread: unreadCount(),
      batches: state.batches.map((b) => ({
        id: b.id,
        sharedBy: b.sharedBy,
        receivedAt: b.receivedAt,
        count: b.items.length,
        unread: b.unread,
        thumbUrl: b.items.length ? b.items[0].url : null,
        open: b.id === state.openBatchId,
      })),
      frame: entry
        ? {
            url: entry.items[state.frameIndex] ? entry.items[state.frameIndex].url : null,
            filename: entry.items[state.frameIndex] ? entry.items[state.frameIndex].filename : '',
            index: state.frameIndex,
            count: entry.items.length,
            sharedBy: entry.sharedBy,
          }
        : null,

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
    noteInteraction,
    recentlyInteracted,
    addBatch,
    openBatch,
    openEntry,
    step,
    unreadCount,
    markOpenRead,
    setPage,
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
