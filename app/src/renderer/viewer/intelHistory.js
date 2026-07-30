'use strict';

// Received-intel history + unread bookkeeping for the viewer's side panel.
// Pure logic, no DOM — the renderer loads it as a plain <script> (this project
// has no bundler) and dev-intel-history-test.js requires it with plain node.
//
// Before this existed, each incoming batch simply replaced the browsable set
// and the previous one was gone. The panel keeps them, so a second sharer
// can't wipe out intel you hadn't read yet.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IntelHistory = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  // Each entry retains every photo's data URL, so this count is really a
  // memory cap: ~3 photos x ~0.7 MB of base64 per entry puts 25 entries near
  // 50 MB — well past a realistic mission's worth of reveals.
  const MAX_ENTRIES = 25;

  class IntelHistory {
    constructor({ maxEntries = MAX_ENTRIES } = {}) {
      this.maxEntries = maxEntries;
      this.entries = []; // newest first
      this.currentId = null;
      this._nextId = 1;
    }

    /**
     * Records a newly received batch and makes it the displayed one (arriving
     * intel always takes the screen — that's the whole point of the app).
     * `read: true` when the window already had focus, since the user is
     * demonstrably looking at it.
     */
    add(batch, { receivedAt = Date.now(), read = false } = {}) {
      const entry = {
        id: this._nextId++,
        sharedBy: batch.sharedBy || '',
        items: batch.items || [],
        receivedAt,
        unread: !read,
      };
      this.entries.unshift(entry);
      if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries;
      this.currentId = entry.id;
      return entry;
    }

    get current() {
      return this.entries.find((entry) => entry.id === this.currentId) || null;
    }

    get unreadCount() {
      return this.entries.reduce((n, entry) => n + (entry.unread ? 1 : 0), 0);
    }

    /** Displays an earlier entry (and marks it read — they clicked it). */
    select(id) {
      const entry = this.entries.find((e) => e.id === id);
      if (!entry) return null;
      this.currentId = entry.id;
      entry.unread = false;
      return entry;
    }

    /** Marks whatever is on screen as read (window focused, user navigated…). */
    markCurrentRead() {
      const entry = this.current;
      if (entry) entry.unread = false;
      return entry;
    }
  }

  /** 24-hour clock — this is a flight-sim tool, "14:32" beats "2:32 PM". */
  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function describeCount(n) {
    return `${n} photo${n === 1 ? '' : 's'}`;
  }

  return { IntelHistory, formatTime, describeCount, MAX_ENTRIES };
});
