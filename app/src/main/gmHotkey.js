'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { globalShortcut } = require('electron');
const { readPhotoFolder } = require('./relayServer');

/**
 * Reads every photo in `photosDir/<missionName>/`, shows it on the GM's own
 * viewer window immediately (no network round-trip for self), and hands the
 * same items to the embedded relay server for fan-out to everyone else.
 * Returned separately from hotkey registration so dev/test harnesses can
 * trigger a reveal directly without needing to simulate a real OS keypress.
 */
function revealMissionFolder({ photosDir, missionName, viewer, relayServer, onLog = () => {} }) {
  const folderPath = path.join(photosDir, missionName);

  if (!fs.existsSync(folderPath)) {
    onLog(`mission photo folder not found: ${folderPath}`);
    return;
  }

  const items = readPhotoFolder(folderPath);
  if (items.length === 0) {
    onLog(`no photos found in ${folderPath}`);
    return;
  }

  viewer.showBatch({ batchId: crypto.randomUUID(), items });
  relayServer.broadcastRevealBatch(items);
  onLog(`revealed ${items.length} photo(s) from ${folderPath}`);
}

/** Registers the GM's global reveal hotkey, wired to revealMissionFolder(). */
function registerGmHotkey(opts) {
  if (!opts.hotkey) return;
  globalShortcut.register(opts.hotkey, () => revealMissionFolder(opts));
}

module.exports = { registerGmHotkey, revealMissionFolder };
