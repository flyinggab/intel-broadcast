'use strict';

const fs = require('fs');
const { readPhotoFolder } = require('./relayServer');

/**
 * Reads every photo directly inside `photosFolder` and sends the batch UP to
 * the relay through this instance's RelayClient. The relay fans it out to
 * every connected client INCLUDING this sender — the photos appear on this
 * machine's own viewer when the echo comes back, which doubles as delivery
 * confirmation. Any instance can share (unified mode); the reveal hotkey is
 * registered centrally in index.js, and this stays a plain function so
 * dev/test harnesses can trigger a reveal without simulating an OS keypress.
 */
function revealPhotosFolder({ photosFolder, relayClient, onLog = () => {} }) {
  if (!photosFolder || !fs.existsSync(photosFolder)) {
    onLog(`photos folder not found: ${photosFolder} (set it via the Settings window)`);
    return;
  }

  const items = readPhotoFolder(photosFolder);
  if (items.length === 0) {
    onLog(`no photos found in ${photosFolder}`);
    return;
  }

  const batchId = relayClient.sendRevealBatch(items);
  if (!batchId) {
    onLog('not connected to the relay — reveal not sent');
    return;
  }
  onLog(`sent ${items.length} photo(s) from ${photosFolder} to the relay`);
}

module.exports = { revealPhotosFolder };
