'use strict';

// Pure display formatters for the viewer. No DOM — the renderer loads this as
// a plain <script> (this project has no bundler) and dev-format-test.js
// requires it with plain node.
//
// They live here rather than in viewer.js so they can be tested at all:
// viewer.js reads `document` at load, so nothing inside it is reachable from
// plain node. These three are the only pure functions in the renderer, and
// every one of them formats a string that goes on a pilot's knee.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Format = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  // Zulu time throughout: this is a flight-sim tool and the design specifies
  // "1432Z". UTC, no separator, matching how a mission brief reads.
  function zulu(ts) {
    if (!ts) return '----Z';
    const d = new Date(ts);
    return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
  }

  function megabytes(bytes) {
    if (!bytes) return '0 MB';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function photoWord(n) {
    return `${n} ${n === 1 ? 'PHOTO' : 'PHOTOS'}`;
  }

  return { zulu, megabytes, photoWord };
});
