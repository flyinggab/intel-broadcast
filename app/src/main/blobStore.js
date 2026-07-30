'use strict';

const crypto = require('crypto');

// Image bytes for the renderer, addressed by CONTENT HASH (ROADMAP §5.1).
//
// Replaces the base64 data URL the viewer used to build (BRIEF §9.1). That
// inflated every photo by 33%, structured-cloned the string across IPC, and
// made Chromium base64-decode it again on the other side — three copies of
// every image for no benefit. The renderer now only ever holds a URL string.
//
// Keyed by sha256(content), NOT a fresh UUID: phase 2's content addressing
// then reuses this same store and the same renderer URLs, making it a wire
// change rather than a storage rewrite. It also dedupes for free — the same
// photo re-revealed is one entry.
//
// Pure Node (no Electron) so it unit-tests with plain node; index.js wires
// the `intel://` scheme to get().

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function createBlobStore({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const blobs = new Map(); // hash -> { buffer, mimeType }
  let totalBytes = 0;

  /** Stores bytes and returns their content hash (the URL path). */
  function put(buffer, mimeType = 'application/octet-stream') {
    const hash = sha256(buffer);
    const existing = blobs.get(hash);
    if (existing) {
      // LRU touch — identical content, already held.
      blobs.delete(hash);
      blobs.set(hash, existing);
      return hash;
    }
    blobs.set(hash, { buffer, mimeType });
    totalBytes += buffer.length;
    evict();
    return hash;
  }

  // Oldest-first eviction. The renderer may still hold a URL for an evicted
  // blob; get() returning null makes that a 404 (broken image) rather than
  // unbounded memory, which is the right trade for a long session.
  function evict() {
    while (totalBytes > maxBytes && blobs.size > 1) {
      const oldest = blobs.keys().next().value;
      totalBytes -= blobs.get(oldest).buffer.length;
      blobs.delete(oldest);
    }
  }

  function get(hash) {
    const entry = blobs.get(hash);
    if (!entry) return null;
    blobs.delete(hash);
    blobs.set(hash, entry);
    return entry;
  }

  function has(hash) {
    return blobs.has(hash);
  }

  /** `intel://blob/<sha256>` — the form phase 2 keeps. */
  function urlFor(hash) {
    return `intel://blob/${hash}`;
  }

  /** Extracts the hash from an intel:// URL, or null if it isn't one. */
  function hashFromUrl(url) {
    const match = /^intel:\/\/blob\/([0-9a-f]{64})$/.exec(String(url || ''));
    return match ? match[1] : null;
  }

  return {
    put,
    get,
    has,
    urlFor,
    hashFromUrl,
    size: () => blobs.size,
    bytes: () => totalBytes,
    clear: () => {
      blobs.clear();
      totalBytes = 0;
    },
  };
}

module.exports = { createBlobStore, sha256, DEFAULT_MAX_BYTES };
