'use strict';

// Writing back into a card's DATA. The mirror of card.js, which turns data
// into a sheet; this turns an edit on the sheet back into data.
//
// Paths come from the resolver as `route.legs[3].alt` — absolute, because an
// edit has to name a place in the card, not a place in a row nobody else can
// see. Nothing here parses a template or knows what a block is.
//
// Pure Node, no Electron.

// Keys that are not data. A path is built from a TEMPLATE's token, and a
// template is a file another pilot wrote — `{__proto__}` in one would
// otherwise let it write onto Object.prototype through here, which is every
// object in the process at once. Blocked at the parse, so nothing downstream
// has to remember.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** `route.legs[3].alt` -> ['route', 'legs', '3', 'alt'] */
function parsePath(path) {
  if (typeof path !== 'string' || !path) return null;
  const keys = [];
  for (const part of path.split('.')) {
    const m = /^([A-Za-z_][\w-]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) return null;
    if (FORBIDDEN_KEYS.has(m[1])) return null;
    keys.push(m[1]);
    for (const idx of m[2].matchAll(/\[(\d+)\]/g)) keys.push(idx[1]);
  }
  return keys;
}

/**
 * Writes `value` at `path`, creating the objects on the way if they are
 * missing — editing a `{note|blank}` on a row that has never had a note is
 * the normal case, not an error.
 *
 * Returns true if anything changed. Refuses a path that would walk into an
 * array by name or an object by index, because a card is untrusted input and
 * a malformed path must not reshape it.
 */
function setAt(card, path, value) {
  const keys = parsePath(path);
  if (!keys || !card || typeof card !== 'object') return false;

  let cur = card;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    const nextIsIndex = /^\d+$/.test(keys[i + 1]);
    if (cur[key] === undefined || cur[key] === null) cur[key] = nextIsIndex ? [] : {};
    if (typeof cur[key] !== 'object') return false;
    if (Array.isArray(cur[key]) !== nextIsIndex) return false; // shape mismatch
    cur = cur[key];
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(cur) !== /^\d+$/.test(last)) return false;
  if (cur[last] === value) return false;
  cur[last] = value;
  return true;
}

/** The array a repeated block draws its rows from, or null. */
function rowsAt(card, repeatPath) {
  const keys = parsePath(repeatPath);
  if (!keys) return null;
  let cur = card;
  for (const key of keys) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[key];
  }
  return Array.isArray(cur) ? cur : null;
}

/**
 * Appends an EMPTY row.
 *
 * Empty, not placeholder: a leg you have not planned yet should look like a
 * leg you have not planned yet, and inventing values would put text on a
 * kneeboard that nobody wrote. `fields` comes from the template — the keys its
 * row spec names — because a row missing them is a card the template refuses.
 * `at` inserts rather than appends, which is what Enter in a prose list means.
 */
function addRow(card, repeatPath, { max = Infinity, fields = [], kind = 'object', at = null } = {}) {
  const rows = rowsAt(card, repeatPath);
  if (!rows) return { ok: false, reason: 'no such list' };
  if (rows.length >= max) return { ok: false, reason: "at the template's row limit" };

  // WHAT A ROW IS depends on the block. A steps or table row is an object of
  // fields; a PROSE list holds plain strings, and pushing an object into one
  // makes a card the resolver refuses outright.
  let row;
  if (kind === 'text') {
    row = '';
  } else {
    // Seeded with the keys the template's row spec names, empty. A bare `{}`
    // renders as a card the template REFUSES, because a token with no fallback
    // that resolves to nothing is an error by design — see rowFieldsOf.
    row = {};
    for (const key of fields) row[key] = '';
  }

  const index = Number.isInteger(at) && at >= 0 && at <= rows.length ? at : rows.length;
  rows.splice(index, 0, row);
  return { ok: true, index };
}

function removeRow(card, repeatPath, index) {
  const rows = rowsAt(card, repeatPath);
  if (!rows) return { ok: false, reason: 'no such list' };
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) {
    return { ok: false, reason: 'no such row' };
  }
  rows.splice(index, 1);
  return { ok: true, index };
}

/**
 * Moves ticks so they stay on the step they were put on.
 *
 * Ticks are keyed by ROW INDEX, so inserting or removing a row above a ticked
 * one silently slides the tick onto a different leg — the app would appear to
 * have lost track of where the flight is, which is worse than losing the tick
 * outright because it is confidently wrong.
 *
 * `delta` is +1 for an insert at `from`, -1 for a removal at `from`. A tick on
 * the row being REMOVED goes with it.
 */
function reindexTicks(ticks, from, delta) {
  const out = new Map();
  for (const [index, done] of ticks) {
    if (delta < 0 && index === from) continue; // the row it belonged to is gone
    out.set(index >= from ? index + delta : index, done);
  }
  return out;
}

module.exports = { parsePath, setAt, rowsAt, addRow, removeRow, reindexTicks };
