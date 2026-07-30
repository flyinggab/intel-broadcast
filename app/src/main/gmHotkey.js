'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { readPhotoFolder } = require('./relayServer');

/**
 * Reads every photo directly inside `photosFolder`, shows it on the GM's own
 * viewer window immediately (no network round-trip for self), and hands the
 * same items to the embedded relay server for fan-out to everyone else.
 * The reveal hotkey itself is registered centrally in index.js (so a settings
 * save can re-register it live); this stays a plain function so dev/test
 * harnesses can trigger a reveal without simulating a real OS keypress.
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

module.exports = { revealPhotosFolder };
