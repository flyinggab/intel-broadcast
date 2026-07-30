'use strict';

const fs = require('fs');
const path = require('path');
const { readPhotoFolder } = require('./relayServer');
const { resolveSelection } = require('./photoLibrary');

/**
 * Sends the selected photos from `photosFolder` UP to the relay, which fans
 * them out to every connected client INCLUDING this sender — the echo is this
 * machine's own render path and its delivery confirmation.
 *
 * `selection` is the filename allowlist from the share gallery; null means
 * everything in the folder, which is what keeps the reveal hotkey behaving as
 * it did before the gallery existed.
 *
 * When `prep` is supplied, each photo goes through sender-side compression
 * first (BRIEF §8). That happens ONCE here rather than on every rebroadcast:
 * the host multiplies payload size by the number of pilots, so one pass by the
 * sharer removes it from N transmissions. The cache is normally already warm,
 * because the gallery warms it when the selection changes.
 */
function revealPhotosFolder({
  photosFolder,
  relayClient,
  selection = null,
  prep = null,
  profileName = 'kneeboard',
  onLog = () => {},
}) {
  if (!photosFolder || !fs.existsSync(photosFolder)) {
    onLog(`photos folder not found: ${photosFolder} (set it via the Settings window)`);
    return { ok: false, reason: 'photos folder not found — set it in Settings' };
  }

  const all = readPhotoFolder(photosFolder);
  const wanted = new Set(resolveSelection(all.map((item) => item.filename), selection));
  let items = all.filter((item) => wanted.has(item.filename));

  if (items.length === 0) {
    const reason = selection && selection.length > 0 ? 'selected photos are no longer in the folder' : 'no photos in the folder';
    onLog(`${reason}: ${photosFolder}`);
    return { ok: false, reason };
  }

  if (prep) {
    items = items.map((item) => {
      const prepared = prep.get(path.join(photosFolder, item.filename), profileName);
      // Falls back to the original on any failure: a reveal that ships a fat
      // photo beats a reveal that ships nothing.
      return prepared || item;
    });
  }

  const batchId = relayClient && relayClient.sendRevealBatch(items);
  if (!batchId) {
    onLog('not connected to the relay — reveal not sent');
    return { ok: false, reason: 'not connected to the relay' };
  }
  const bytes = items.reduce((n, i) => n + i.buffer.length, 0);
  onLog(`sent ${items.length} photo(s), ${(bytes / 1024).toFixed(0)}KB from ${photosFolder}`);
  return { ok: true, count: items.length, bytes };
}

module.exports = { revealPhotosFolder };
