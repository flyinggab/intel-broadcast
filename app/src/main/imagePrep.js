'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Sender-side downscale + recompress, applied once before a batch goes up to
 * the relay.
 *
 * WHY SENDER-SIDE ONCE: the host fans a batch out to every client, so payload
 * size is multiplied by the number of connected pilots. Shrinking on the way
 * in costs the sharer one pass and saves the host N transmissions. Doing it on
 * the host instead would mean decode + re-encode on every rebroadcast, adding
 * latency and CPU to the one process that can least afford either.
 *
 * WHY nativeImage: it ships with Electron and photoLibrary.js already uses it
 * for thumbnails. No native module, no electron-rebuild, nothing extra for the
 * release workflow to sign. It decodes exactly the formats photoLibrary
 * whitelists (JPEG, PNG), it strips EXIF on re-encode (so GPS and camera data
 * never leave the machine), and it never upscales when you ask for a height
 * larger than the source.
 *
 * NOTHING ON THE WIRE CHANGES. buildRevealFrames() computes byteLength and
 * sha256 from whatever buffer it is handed, so compressing before that point
 * keeps the frames self-consistent and older clients none the wiser.
 */

/**
 * Long edge in pixels, and JPEG quality.
 *
 * 1600 is not arbitrary: the viewer is A4 portrait at ~85% of the work area,
 * so on a 4K display it renders at roughly 1200x1700, and OpenKneeboard then
 * resamples that into VR at lower effective resolution again. Anything above
 * ~1600 on the long edge is pixels no pilot will ever resolve, paid for by
 * everyone on the relay.
 */
const PROFILES = {
  kneeboard: { longEdge: 1600, quality: 82, label: 'KNEEBOARD' },
  sharp:     { longEdge: 2200, quality: 90, label: 'SHARP' },
  original:  { longEdge: null, quality: null, label: 'ORIGINAL' },
};
const DEFAULT_PROFILE = 'kneeboard';

/** Below this, a file is already cheap; recompressing only adds generation loss. */
const PASSTHROUGH_BYTES = 400 * 1024;

/** Guard against a pathological source eating the main process. */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

function profileFor(name) {
  return PROFILES[name] || PROFILES[DEFAULT_PROFILE];
}

/**
 * Cache key. mtimeMs + size means editing a photo in place invalidates it,
 * and the profile is in the key so switching profiles doesn't serve stale
 * bytes.
 */
function cacheKey(fullPath, stat, profileName) {
  return `${fullPath}|${stat.mtimeMs}|${stat.size}|${profileName}`;
}

/** A JPEG re-encode of foo.png is not a .png any more. */
function rewriteExtension(filename, mimeType) {
  if (mimeType !== 'image/jpeg') return filename;
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return filename;
  return path.basename(filename, path.extname(filename)) + '.jpg';
}

/**
 * Decide before doing any work. Pure, so it is testable without Electron.
 * Returns { action: 'passthrough' | 'compress', reason, targetLongEdge, quality }
 */
function planCompression({ byteLength, width, height, profileName }) {
  const p = profileFor(profileName);
  if (!p.longEdge) return { action: 'passthrough', reason: 'profile is original' };
  if (byteLength > MAX_SOURCE_BYTES) {
    return { action: 'passthrough', reason: 'source too large to decode safely' };
  }
  const longEdge = Math.max(width || 0, height || 0);
  const alreadySmall = byteLength <= PASSTHROUGH_BYTES;
  const alreadyShort = longEdge > 0 && longEdge <= p.longEdge;
  // Only skip when BOTH hold: a 6000px image at 300KB still wastes decode time
  // on every client, and a 400x400 image at 4MB is worth re-encoding.
  if (alreadySmall && alreadyShort) {
    return { action: 'passthrough', reason: 'already small and within target' };
  }
  return { action: 'compress', targetLongEdge: p.longEdge, quality: p.quality };
}

/**
 * Compress one file. `deps.nativeImage` is injected so this is testable.
 * Falls back to the original buffer on any failure — a reveal that ships a
 * fat photo beats a reveal that ships nothing.
 */
function prepareOne(fullPath, { profileName = DEFAULT_PROFILE, deps = {}, onLog = () => {} } = {}) {
  const nativeImage = deps.nativeImage || require('electron').nativeImage;
  const original = fs.readFileSync(fullPath);
  const filename = path.basename(fullPath);
  const srcMime = path.extname(filename).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
  const fallback = { filename, mimeType: srcMime, buffer: original, compressed: false };

  try {
    const image = nativeImage.createFromPath(fullPath);
    if (image.isEmpty()) return fallback;

    const size = image.getSize();
    const plan = planCompression({
      byteLength: original.length,
      width: size.width,
      height: size.height,
      profileName,
    });
    if (plan.action === 'passthrough') {
      onLog(`prep ${filename}: kept as-is (${plan.reason})`);
      return fallback;
    }

    // resize() preserves aspect ratio when only one dimension is given, and
    // will not upscale past the source.
    const portrait = size.height >= size.width;
    const resized = portrait
      ? image.resize({ height: Math.min(plan.targetLongEdge, size.height), quality: 'better' })
      : image.resize({ width: Math.min(plan.targetLongEdge, size.width), quality: 'better' });

    const out = resized.toJPEG(plan.quality);
    // Re-encoding is not guaranteed to win — a small PNG of flat colour can
    // grow as a JPEG. Keep whichever is smaller.
    if (!out || out.length >= original.length) {
      onLog(`prep ${filename}: re-encode was not smaller, kept original`);
      return fallback;
    }

    const saved = (1 - out.length / original.length) * 100;
    onLog(
      `prep ${filename}: ${(original.length / 1024).toFixed(0)}KB -> ` +
        `${(out.length / 1024).toFixed(0)}KB (-${saved.toFixed(0)}%)`,
    );
    return {
      filename: rewriteExtension(filename, 'image/jpeg'),
      mimeType: 'image/jpeg',
      buffer: out,
      compressed: true,
    };
  } catch (err) {
    onLog(`prep ${filename}: failed (${err.message}), sending original`);
    return fallback;
  }
}

/**
 * Cached front door. Warm this when the share selection changes so the reveal
 * hotkey stays instant — compressing 8 photos on the keypress costs a few
 * hundred ms on the main process, which is exactly the moment you cannot
 * afford to block.
 */
function createImagePrep({ deps = {}, onLog = () => {}, maxEntries = 60 } = {}) {
  const cache = new Map(); // key -> { filename, mimeType, buffer, compressed }

  function get(fullPath, profileName = DEFAULT_PROFILE) {
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      return null;
    }
    const key = cacheKey(fullPath, stat, profileName);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit); // LRU touch
      return hit;
    }
    const prepared = prepareOne(fullPath, { profileName, deps, onLog });
    cache.set(key, prepared);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return prepared;
  }

  /** Fire-and-forget warm, one file per tick so the UI stays responsive. */
  function warm(fullPaths, profileName = DEFAULT_PROFILE) {
    const queue = [...fullPaths];
    const step = () => {
      const next = queue.shift();
      if (!next) return;
      get(next, profileName);
      setImmediate(step);
    };
    setImmediate(step);
  }

  /** Total bytes a selection will actually put on the wire. */
  function stagedBytes(fullPaths, profileName = DEFAULT_PROFILE) {
    return fullPaths.reduce((sum, p) => {
      const item = get(p, profileName);
      return sum + (item ? item.buffer.length : 0);
    }, 0);
  }

  return { get, warm, stagedBytes, clear: () => cache.clear(), size: () => cache.size };
}

module.exports = {
  createImagePrep,
  prepareOne,
  planCompression,
  rewriteExtension,
  cacheKey,
  PROFILES,
  DEFAULT_PROFILE,
  PASSTHROUGH_BYTES,
  MAX_SOURCE_BYTES,
};
