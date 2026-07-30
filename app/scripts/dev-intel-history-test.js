'use strict';

// Unit test for the viewer panel's received-intel history + unread rules.
// Pure Node (intelHistory.js is deliberately DOM-free so this can exist).
//
// Usage: node scripts/dev-intel-history-test.js

const assert = require('assert');
const { IntelHistory, formatTime, describeCount } = require('../src/renderer/viewer/intelHistory');

function batch(sharedBy, itemCount = 2) {
  return { sharedBy, items: Array.from({ length: itemCount }, (_, i) => ({ filename: `${i}.jpg`, dataUrl: 'data:,' })) };
}

// --- Newest first, current follows the newest arrival ------------------------
{
  const h = new IntelHistory();
  h.add(batch('alpha'));
  const second = h.add(batch('bravo'));
  assert.deepStrictEqual(h.entries.map((e) => e.sharedBy), ['bravo', 'alpha'], 'newest first');
  assert.strictEqual(h.current.id, second.id, 'newest arrival is displayed');
  console.log('[test] ordering OK');
}

// --- Unread accounting -------------------------------------------------------
{
  const h = new IntelHistory();
  const a = h.add(batch('alpha'));
  const b = h.add(batch('bravo'));
  assert.strictEqual(h.unreadCount, 2, 'arrivals start unread when the window is unfocused');

  // Focus (or navigating) marks only what's on screen read.
  h.markCurrentRead();
  assert.strictEqual(h.unreadCount, 1, 'only the displayed entry cleared');
  assert.strictEqual(h.entries.find((e) => e.id === b.id).unread, false);
  assert.strictEqual(h.entries.find((e) => e.id === a.id).unread, true, 'older entry still unread');

  // Clicking the older one displays and clears it.
  const selected = h.select(a.id);
  assert.strictEqual(selected.id, a.id);
  assert.strictEqual(h.current.id, a.id, 'selection changes what is displayed');
  assert.strictEqual(h.unreadCount, 0);

  // A batch that arrives while focused is never unread.
  h.add(batch('charlie'), { read: true });
  assert.strictEqual(h.unreadCount, 0, 'arrival while focused is already read');
  console.log('[test] unread rules OK');
}

// --- Selecting something that has been evicted is a no-op --------------------
{
  const h = new IntelHistory();
  const first = h.add(batch('alpha'));
  assert.strictEqual(h.select(first.id + 999), null, 'unknown id returns null');
  assert.strictEqual(h.current.id, first.id, 'current unchanged after a failed select');
  console.log('[test] unknown id OK');
}

// --- Memory cap: oldest entries are evicted ---------------------------------
{
  const h = new IntelHistory({ maxEntries: 3 });
  for (const name of ['a', 'b', 'c', 'd', 'e']) h.add(batch(name, 1));
  assert.strictEqual(h.entries.length, 3, 'capped');
  assert.deepStrictEqual(h.entries.map((e) => e.sharedBy), ['e', 'd', 'c'], 'oldest dropped');
  assert.ok(h.current, 'current survives eviction (it is the newest)');
  console.log('[test] eviction OK');
}

// --- Formatting --------------------------------------------------------------
{
  const noon = new Date(2026, 6, 30, 14, 32, 5).getTime();
  assert.match(formatTime(noon), /^14:32$/, '24-hour clock, no seconds');
  assert.strictEqual(describeCount(1), '1 photo');
  assert.strictEqual(describeCount(3), '3 photos');
  console.log('[test] formatting OK');
}

// --- Missing sharedBy is tolerated (empty callsign is allowed on the wire) ---
{
  const h = new IntelHistory();
  const entry = h.add({ items: [] });
  assert.strictEqual(entry.sharedBy, '');
  assert.strictEqual(entry.items.length, 0);
  console.log('[test] empty batch tolerated OK');
}

console.log('[dev-intel-history-test] PASS');
