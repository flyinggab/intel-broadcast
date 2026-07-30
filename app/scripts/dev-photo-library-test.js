'use strict';

// Unit test for photoLibrary.js's listing/selection half (the part that
// decides what the share gallery shows and what a reveal actually sends).
// Pure Node — thumbnails need Electron and are covered by the panel e2e.
//
// Usage: node scripts/dev-photo-library-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { listPhotoFilenames, resolveSelection, isPhoto } = require('../src/main/photoLibrary');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-photo-lib-'));

try {
  for (const name of ['02-second.jpg', '01-first.JPG', '03-third.png', 'notes.txt', 'thumbs.db']) {
    fs.writeFileSync(path.join(DIR, name), 'x');
  }
  fs.mkdirSync(path.join(DIR, 'subfolder'));
  fs.writeFileSync(path.join(DIR, 'subfolder', '04-nested.jpg'), 'x');

  // --- Listing: photos only, sorted, no recursion ---------------------------
  const listed = listPhotoFilenames(DIR);
  assert.deepStrictEqual(listed, ['01-first.JPG', '02-second.jpg', '03-third.png'], 'sorted photos only');
  assert.ok(!listed.includes('04-nested.jpg'), 'does not recurse into subfolders');
  assert.ok(isPhoto('a.JPEG') && isPhoto('a.png') && !isPhoto('a.gif'), 'extension check is case-insensitive');
  console.log('[test] listing OK');

  // --- Missing/unreadable folder is an empty gallery, not a crash -----------
  assert.deepStrictEqual(listPhotoFilenames(path.join(DIR, 'nope')), []);
  assert.deepStrictEqual(listPhotoFilenames(null), []);
  assert.deepStrictEqual(listPhotoFilenames(''), []);
  console.log('[test] missing folder OK');

  // --- Selection resolution -------------------------------------------------
  // null means "everything" — this is what keeps the reveal hotkey behaving
  // as it did before the gallery existed.
  assert.deepStrictEqual(resolveSelection(listed, null), listed, 'null selection = all');
  assert.deepStrictEqual(resolveSelection(listed, undefined), listed);

  assert.deepStrictEqual(
    resolveSelection(listed, ['03-third.png', '01-first.JPG']),
    ['01-first.JPG', '03-third.png'],
    'folder order wins over click order',
  );

  assert.deepStrictEqual(
    resolveSelection(listed, ['01-first.JPG', 'deleted-since.jpg']),
    ['01-first.JPG'],
    'filenames no longer in the folder are dropped',
  );

  assert.deepStrictEqual(resolveSelection(listed, []), [], 'explicit empty selection sends nothing');
  console.log('[test] selection resolution OK');

  console.log('[dev-photo-library-test] PASS');
} finally {
  fs.rmSync(DIR, { recursive: true, force: true });
}
