'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { globalShortcut } = require('electron');
const { readPhotoFolder } = require('./relayServer');

/**
 * Reads every photo directly inside `photosFolder`, shows it on the GM's own
 * viewer window immediately (no network round-trip for self), and hands the
 * same items to the embedded relay server for fan-out to everyone else.
 * Returned separately from hotkey registration so dev/test harnesses can
 * trigger a reveal directly without needing to simulate a real OS keypress.
 */
function revealPhotosFolder({ photosFolder, viewer, relayServer, onLog = () => {} }) {
  if (!photosFolder || !fs.existsSync(photosFolder)) {
    onLog(`photos folder not found: ${photosFolder} (set it via the Settings window)`);
    return;
  }

  const items = readPhotoFolder(photosFolder);
  if (items.length === 0) {
    onLog(`no photos found in ${photosFolder}`);
    return;
  }

  viewer.showBatch({ batchId: crypto.randomUUID(), items });
  relayServer.broadcastRevealBatch(items);
  onLog(`revealed ${items.length} photo(s) from ${photosFolder}`);
}

/** Registers the GM's global reveal hotkey, wired to revealPhotosFolder(). */
function registerGmHotkey(opts) {
  if (!opts.hotkey) return;
  const ok = globalShortcut.register(opts.hotkey, () => revealPhotosFolder(opts));
  console.log(`[gmHotkey] register reveal "${opts.hotkey}": ${ok ? 'OK' : 'FAILED (already taken by another app?)'}`);
}

module.exports = { registerGmHotkey, revealPhotosFolder };
