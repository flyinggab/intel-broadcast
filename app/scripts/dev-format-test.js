'use strict';

// Unit test for the viewer's pure display formatters.
//
// Replaces the formatting half of dev-intel-history-test.js, which was deleted
// with its module in phase 1: the history/unread half it also covered now
// lives in main and is tested by dev-viewstate-test.js, but these formatters
// moved into viewer.js and became untestable there (viewer.js reads `document`
// at load). viewer/format.js exists so they are reachable from plain node.
//
// Note the deliberate change of behaviour phase 1 made: the old module
// formatted local 24-hour time ("14:32"); the design calls for Zulu ("1432Z").
// That is why the old assertion is not carried over verbatim.
//
// Usage: node scripts/dev-format-test.js

const assert = require('assert');
const { zulu, megabytes, photoWord } = require('../src/renderer/viewer/format');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`[test] ${name}: PASS`);
  } catch (err) {
    failures += 1;
    console.error(`[test] ${name}: FAIL — ${err.message}`);
  }
}

// --- zulu --------------------------------------------------------------------

check('zulu is UTC, 4 digits, no separator', () => {
  // 14:32 UTC on a fixed date. Asserted in UTC on purpose: a local-time
  // implementation would pass this only in one timezone.
  assert.strictEqual(zulu(Date.UTC(2026, 6, 30, 14, 32, 45)), '1432Z');
});

check('zulu pads single digits', () => {
  assert.strictEqual(zulu(Date.UTC(2026, 6, 30, 4, 7, 0)), '0407Z');
  assert.strictEqual(zulu(Date.UTC(2026, 6, 30, 0, 0, 0)), '0000Z');
});

check('zulu drops seconds rather than rounding', () => {
  assert.strictEqual(zulu(Date.UTC(2026, 6, 30, 9, 59, 59)), '0959Z');
});

check('zulu renders a missing timestamp as dashes, not 0000Z', () => {
  // A batch with no receivedAt must not read as midnight Zulu.
  assert.strictEqual(zulu(0), '----Z');
  assert.strictEqual(zulu(undefined), '----Z');
  assert.strictEqual(zulu(null), '----Z');
});

// --- photoWord ---------------------------------------------------------------

check('photoWord singular/plural', () => {
  assert.strictEqual(photoWord(1), '1 PHOTO');
  assert.strictEqual(photoWord(3), '3 PHOTOS');
});

check('photoWord pluralises zero', () => {
  assert.strictEqual(photoWord(0), '0 PHOTOS');
});

// --- megabytes ---------------------------------------------------------------

check('megabytes switches unit at 1 MiB', () => {
  assert.strictEqual(megabytes(1024 * 1024 - 1), '1024 KB');
  assert.strictEqual(megabytes(1024 * 1024), '1.0 MB');
  assert.strictEqual(megabytes(1.44 * 1024 * 1024), '1.4 MB');
});

check('megabytes never reports a non-empty payload as 0 KB', () => {
  // Rounding 1 byte down to "0 KB" would read as "nothing staged".
  assert.strictEqual(megabytes(1), '1 KB');
  assert.strictEqual(megabytes(400), '1 KB');
});

check('megabytes renders empty as 0 MB', () => {
  assert.strictEqual(megabytes(0), '0 MB');
  assert.strictEqual(megabytes(undefined), '0 MB');
});

if (failures) {
  console.error(`\n[format] FAIL — ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\n[format] PASS');
