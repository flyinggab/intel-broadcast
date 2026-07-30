'use strict';

// Unit test for blobStore.js — the content-addressed store that replaced
// base64 data URLs (BRIEF §9.1) and that phase 2's content addressing reuses
// (ROADMAP §5.1).
//
// Usage: node scripts/dev-blobstore-test.js

const assert = require('assert');
const crypto = require('crypto');
const { createBlobStore, sha256 } = require('../src/main/blobStore');

const buf = (fill, size = 1024) => Buffer.alloc(size, fill);

// --- Keyed by CONTENT, not identity -----------------------------------------
{
  const store = createBlobStore();
  const a = store.put(buf(1), 'image/jpeg');
  const again = store.put(buf(1), 'image/jpeg'); // byte-identical
  const b = store.put(buf(2), 'image/jpeg');

  assert.strictEqual(a, again, 'identical bytes must produce one entry');
  assert.notStrictEqual(a, b);
  assert.strictEqual(store.size(), 2, 'the duplicate did not add an entry');
  assert.strictEqual(a, sha256(buf(1)), 'the key IS the content hash');
  assert.match(a, /^[0-9a-f]{64}$/);
  console.log('[test] content addressing dedupes for free');
}

// --- URL round trip ----------------------------------------------------------
{
  const store = createBlobStore();
  const hash = store.put(buf(7), 'image/png');
  const url = store.urlFor(hash);
  assert.strictEqual(url, `intel://blob/${hash}`, 'phase 2 keeps this URL shape');
  assert.strictEqual(store.hashFromUrl(url), hash);

  const entry = store.get(hash);
  assert.ok(entry.buffer.equals(buf(7)), 'bytes come back intact');
  assert.strictEqual(entry.mimeType, 'image/png');
  console.log('[test] intel://blob/<sha256> round-trips');
}

// --- Junk URLs are rejected, not guessed --------------------------------------
{
  const store = createBlobStore();
  for (const bad of [
    '',
    null,
    'intel://blob/short',
    'intel://item/abc', // the UUID form we deliberately moved away from
    'http://evil/blob/' + 'a'.repeat(64),
    'intel://blob/' + 'A'.repeat(64), // uppercase is not our hex
    'intel://blob/../../etc/passwd',
  ]) {
    assert.strictEqual(store.hashFromUrl(bad), null, `should reject: ${bad}`);
  }
  assert.strictEqual(store.get('nope'), null, 'a miss is null, i.e. a 404');
  console.log('[test] malformed URLs are rejected (no path traversal surface)');
}

// --- Eviction is bounded and oldest-first --------------------------------------
{
  const store = createBlobStore({ maxBytes: 4096 });
  const first = store.put(buf(1, 2048));
  const second = store.put(buf(2, 2048));
  assert.ok(store.has(first) && store.has(second));

  const third = store.put(buf(3, 2048)); // pushes past the ceiling
  assert.strictEqual(store.has(first), false, 'oldest evicted');
  assert.ok(store.has(second) && store.has(third));
  assert.ok(store.bytes() <= 4096, `bytes tracked: ${store.bytes()}`);
  console.log('[test] eviction is bounded, oldest first');
}

// --- Reading refreshes recency -------------------------------------------------
{
  const store = createBlobStore({ maxBytes: 4096 });
  const a = store.put(buf(1, 2048));
  const b = store.put(buf(2, 2048));
  store.get(a); // a is now the most recently used
  store.put(buf(3, 2048));
  assert.ok(store.has(a), 'recently read blob survives');
  assert.strictEqual(store.has(b), false, 'least recently used went instead');
  console.log('[test] LRU touch on read');
}

// --- Real-ish payload sanity ----------------------------------------------------
{
  const store = createBlobStore();
  const payload = crypto.randomBytes(200 * 1024);
  const hash = store.put(payload, 'image/jpeg');
  assert.ok(store.get(hash).buffer.equals(payload));
  assert.strictEqual(store.bytes(), payload.length);
  // No base64 anywhere: the whole point of §9.1 is that the bytes are handed
  // over as-is, not inflated by a third and re-decoded.
  assert.ok(Buffer.isBuffer(store.get(hash).buffer));
  console.log('[test] payloads are stored as raw buffers');
}

console.log('[dev-blobstore-test] PASS');
