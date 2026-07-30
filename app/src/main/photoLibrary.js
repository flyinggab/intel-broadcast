'use strict';

const fs = require('fs');
const path = require('path');

// Backs the side panel's "Share" gallery: what's in the folder, which of it
// is selected, and small thumbnails for the grid. The listing/selection half
// is pure Node (unit-tested by dev-photo-library-test.js); only
// makeThumbnail() needs Electron, and it requires it lazily so this module
// stays loadable outside the app.

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

// Sanity bound for a pathological folder — the protocol caps a batch at 100
// items anyway, and PLAN.md's guidance is "low double digits" per mission.
const MAX_LISTED = 200;

const THUMBNAIL_HEIGHT = 96;

function isPhoto(name) {
  return Boolean(MIME_BY_EXT[path.extname(name).toLowerCase()]);
}

/**
 * Filenames of every photo directly inside `folderPath`, sorted (the numeric
 * `01-`, `02-` prefix convention sets both gallery and browsing order).
 * Returns [] for a missing/unreadable folder rather than throwing — the
 * gallery renders an empty state instead of breaking the window.
 */
function listPhotoFilenames(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) return [];
  try {
    return fs.readdirSync(folderPath).filter(isPhoto).sort().slice(0, MAX_LISTED);
  } catch {
    return [];
  }
}

/**
 * Resolves a stored selection against what's actually in the folder now.
 * `selection` of null means "everything" — the default, which keeps the
 * reveal hotkey behaving exactly as it did before the gallery existed.
 * Filenames that have since disappeared are dropped; ordering always follows
 * the folder listing, never the order things were clicked.
 */
function resolveSelection(available, selection) {
  if (!Array.isArray(selection)) return available.slice();
  const wanted = new Set(selection);
  return available.filter((name) => wanted.has(name));
}

/** Small data-URL thumbnail for the gallery grid, or null if unreadable. */
function makeThumbnail(fullPath) {
  const { nativeImage } = require('electron');
  try {
    const image = nativeImage.createFromPath(fullPath);
    if (image.isEmpty()) return null;
    return image.resize({ height: THUMBNAIL_HEIGHT, quality: 'good' }).toDataURL();
  } catch {
    return null;
  }
}

/**
 * The gallery payload for the renderer: one entry per photo in the folder,
 * each with a thumbnail and whether it's currently selected for sharing.
 */
function buildGallery(folderPath, selection) {
  const available = listPhotoFilenames(folderPath);
  const selected = new Set(resolveSelection(available, selection));
  return {
    folder: folderPath || '',
    photos: available.map((filename) => ({
      filename,
      selected: selected.has(filename),
      thumbnail: makeThumbnail(path.join(folderPath, filename)),
    })),
  };
}

module.exports = {
  listPhotoFilenames,
  resolveSelection,
  buildGallery,
  makeThumbnail,
  isPhoto,
  MAX_LISTED,
  THUMBNAIL_HEIGHT,
};
