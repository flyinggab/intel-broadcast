'use strict';

// Unit test for keyHook.js — the pass-through keybind matcher.
//
// The point of the hook is that a bound key still reaches everything else, so
// a bare letter is a legitimate binding. That makes exact modifier matching
// essential: if "B" also fired on Ctrl+B, binding B would break every Ctrl+B
// shortcut on the machine, which is the very problem the hook exists to avoid.
//
// Pure matching only — no native listener is started here.
//
// Usage: node scripts/dev-keyhook-test.js

const assert = require('assert');
const { UiohookKey } = require('uiohook-napi');
const { parseAccelerator, matchBinding, eventMatches } = require('../src/main/keyHook');

/** A uiohook-shaped keydown event. */
function down(keycode, mods = {}) {
  return {
    keycode,
    ctrlKey: Boolean(mods.ctrl),
    altKey: Boolean(mods.alt),
    shiftKey: Boolean(mods.shift),
    metaKey: Boolean(mods.meta),
  };
}

// --- parsing ----------------------------------------------------------------
{
  const b = parseAccelerator('B');
  assert.deepStrictEqual(b, { keycode: UiohookKey.B, ctrl: false, alt: false, shift: false, meta: false });

  const combo = parseAccelerator('Ctrl+Shift+I');
  assert.strictEqual(combo.keycode, UiohookKey.I);
  assert.ok(combo.ctrl && combo.shift && !combo.alt && !combo.meta);

  // Arrow and other named keys go through the token map.
  assert.strictEqual(parseAccelerator('Ctrl+Shift+Right').keycode, UiohookKey.ArrowRight);
  assert.strictEqual(parseAccelerator('Left').keycode, UiohookKey.ArrowLeft);
  assert.strictEqual(parseAccelerator('Esc').keycode, UiohookKey.Escape);
  assert.strictEqual(parseAccelerator('Space').keycode, UiohookKey.Space);
  assert.strictEqual(parseAccelerator('F5').keycode, UiohookKey.F5);
  assert.strictEqual(parseAccelerator('CommandOrControl+N').ctrl, true, 'CommandOrControl maps to ctrl');
  console.log('[test] accelerators parse, incl. bare keys and named keys');
}

// --- unparseable input is null, never a throw -------------------------------
{
  for (const bad of ['', null, undefined, 'Ctrl+', 'Ctrl', 'Shift+Alt', 'NoSuchKey', 'A+B', 42, {}]) {
    assert.strictEqual(parseAccelerator(bad), null, `should not parse: ${JSON.stringify(bad)}`);
  }
  // "Ctrl" alone is modifiers-only — a real binding needs a key.
  console.log('[test] junk accelerators parse to null without throwing');
}

// --- exact modifier matching is the whole safety story ----------------------
{
  const bindings = { next: 'N', prev: 'B', reveal: 'Ctrl+Shift+I' };

  assert.strictEqual(matchBinding(bindings, down(UiohookKey.N)), 'next');
  assert.strictEqual(matchBinding(bindings, down(UiohookKey.B)), 'prev');

  // A bare binding must NOT fire when modifiers are held: otherwise binding B
  // would hijack Ctrl+B, Alt+B and Shift+B everywhere.
  for (const mods of [{ ctrl: true }, { alt: true }, { shift: true }, { meta: true }, { ctrl: true, shift: true }]) {
    assert.strictEqual(
      matchBinding(bindings, down(UiohookKey.B, mods)),
      null,
      `bare B must not fire with ${JSON.stringify(mods)} held`,
    );
  }

  // And a combo must not fire on a subset or a superset.
  assert.strictEqual(matchBinding(bindings, down(UiohookKey.I, { ctrl: true, shift: true })), 'reveal');
  assert.strictEqual(matchBinding(bindings, down(UiohookKey.I, { ctrl: true })), null, 'subset must not fire');
  assert.strictEqual(
    matchBinding(bindings, down(UiohookKey.I, { ctrl: true, shift: true, alt: true })),
    null,
    'superset must not fire',
  );
  console.log('[test] modifiers match exactly — a bare key never hijacks its combos');
}

// --- unrelated keys fire nothing (typing stays typing) ----------------------
{
  const bindings = { next: 'N', prev: 'B' };
  for (const key of ['A', 'C', 'Z', 'Space', 'Enter', 'Digit1']) {
    if (UiohookKey[key] === undefined) continue;
    assert.strictEqual(matchBinding(bindings, down(UiohookKey[key])), null, `${key} must not fire a binding`);
  }
  assert.strictEqual(matchBinding({}, down(UiohookKey.N)), null, 'no bindings, no fire');
  assert.strictEqual(matchBinding(null, down(UiohookKey.N)), null);
  console.log('[test] unrelated keys fire nothing');
}

// --- a binding that cannot be parsed is skipped, not fatal ------------------
{
  const bindings = { broken: 'NoSuchKey', good: 'N' };
  assert.strictEqual(matchBinding(bindings, down(UiohookKey.N)), 'good', 'a bad binding must not break the good one');
  console.log('[test] an unparseable binding is skipped');
}

// --- eventMatches guards ----------------------------------------------------
{
  assert.strictEqual(eventMatches(null, down(UiohookKey.N)), false);
  assert.strictEqual(eventMatches(parseAccelerator('N'), null), false);
  console.log('[test] matcher guards against missing input');
}

// --- the module must not log keystrokes -------------------------------------
// This sees every key on the machine, so "it never records anything" has to be
// enforced, not merely intended.
{
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'keyHook.js'), 'utf8');
  const handler = source.slice(source.indexOf('const handler ='), source.indexOf('try {'));
  assert.ok(!/console\.|onLog\(.*event|JSON\.stringify\(event/.test(handler), 'the key handler must not log the event');
  assert.ok(!/push\(|\.write\(|fs\./.test(handler), 'the key handler must not buffer or persist keystrokes');
  console.log('[test] the key handler neither logs nor stores keystrokes');
}

console.log('[dev-keyhook-test] PASS');
