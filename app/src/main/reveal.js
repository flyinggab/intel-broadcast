'use strict';

const fs = require('fs');
const { readPhotoFolder } = require('./relayServer');
const { resolveSelection } = require('./photoLibrary');

/**
 * Reads the selected photos from `photosFolder` and sends them UP to the
 * relay through this instance's RelayClient. The relay fans them out to every
 * connected client INCLUDING this sender — the photos appear on this
 * machine's own viewer when the echo comes back, which doubles as delivery
 * confirmation. Any instance can share (unified mode).
 *
 * `selection` is a filename allowlist from the share gallery, or null for
 * "everything in the folder" — the default, which keeps the reveal hotkey
 * behaving exactly as it did before the gallery existed. The hotkey and the
 * gallery's Share button are two entry points to this one function, so the
 * hotkey always sends whatever the gallery shows as selected.
 *
 * Returns { ok, count } / { ok: false, reason } so the gallery can report
 * back in the UI; the hotkey path just logs.
 */
function revealPhotosFolder({ photosFolder, relayClient, selection = null, onLog = () => {} }) {
  if (!photosFolder || !fs.existsSync(photosFolder)) {
    const reason = `photos folder not found: ${photosFolder} (set it via the Settings window)`;
    onLog(reason);
    return { ok: false, reason: 'photos folder not found — set it in Settings' };
  }

  const all = readPhotoFolder(photosFolder);
  const wanted = new Set(resolveSelection(all.map((item) => item.filename), selection));
  const items = all.filter((item) => wanted.has(item.filename));

  if (items.length === 0) {
    const reason = selection && selection.length > 0 ? 'selected photos are no longer in the folder' : 'no photos in the folder';
    onLog(`${reason}: ${photosFolder}`);
    return { ok: false, reason };
  }

  const batchId = relayClient.sendRevealBatch(items);
  if (!batchId) {
    onLog('not connected to the relay — reveal not sent');
    return { ok: false, reason: 'not connected to the relay' };
  }
  onLog(`sent ${items.length} photo(s) from ${photosFolder} to the relay`);
  return { ok: true, count: items.length };
}

module.exports = { revealPhotosFolder };
