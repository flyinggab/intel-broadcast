'use strict';

// `uiohook-napi` is an OPTIONAL dependency, and this module must survive its
// absence — a top-level require here took the whole app down on macOS, where
// there is no prebuild. It is also the one place the app loads native code,
// so keeping it optional keeps every other platform installable.
//
// The feature it powers is Windows-shaped (see the RegisterHotKey note below);
// without the module `parseAccelerator` returns null for everything, so no
// binding ever matches and `startKeyHook` reports ok:false. Main already
// falls back to Electron's exclusive globalShortcut in that case, and the
// settings toggle already says UNAVAILABLE ON THIS PC.
let UiohookKey = null;
try {
  ({ UiohookKey } = require('uiohook-napi'));
} catch {
  UiohookKey = null;
}

/** Whether the native hook is even installed on this machine. */
function isAvailable() {
  return UiohookKey !== null;
}

// Global keybinds that OBSERVE a key without swallowing it.
//
// WHY THIS EXISTS: Electron's globalShortcut uses Windows' RegisterHotKey,
// which is both exclusive (a second app asking for the same combination just
// fails) and CONSUMING (the key never reaches anything else). Bind plain "B"
// that way and the letter b stops working across the whole machine.
//
// A low-level hook sees each press and passes it on, so a bound key can be a
// bare letter, and another app — OpenKneeboard, DCS, a text field — still gets
// it. That is the whole point, and it is the one thing RegisterHotKey cannot
// be configured into doing.
//
// PRIVACY: this sees every keystroke, so it must be obviously trustworthy.
// Nothing here logs, stores, buffers or transmits a keystroke. Events are
// matched against the configured accelerators and discarded in the same tick;
// the only thing that ever leaves this module is "binding <name> fired".
// Keep it that way.
//
// The matching half is pure and exported for tests; only start() touches the
// native listener.

/** Electron accelerator token -> uiohook key name. Everything else maps by
 *  its own name (letters, digits, F-keys) once upper-cased. */
const TOKEN_TO_UIOHOOK = {
  LEFT: 'ArrowLeft',
  RIGHT: 'ArrowRight',
  UP: 'ArrowUp',
  DOWN: 'ArrowDown',
  SPACE: 'Space',
  ESC: 'Escape',
  ESCAPE: 'Escape',
  RETURN: 'Enter',
  ENTER: 'Enter',
  PLUS: 'Equal',
  TAB: 'Tab',
  BACKSPACE: 'Backspace',
  DELETE: 'Delete',
  HOME: 'Home',
  END: 'End',
  PAGEUP: 'PageUp',
  PAGEDOWN: 'PageDown',
};

const MODIFIER_TOKENS = new Set(['CTRL', 'CONTROL', 'COMMANDORCONTROL', 'CMDORCTRL', 'ALT', 'SHIFT', 'SUPER', 'META', 'CMD', 'COMMAND']);

/**
 * Parses an Electron accelerator ("Ctrl+Shift+I", "B", "Ctrl+Shift+Right")
 * into { keycode, ctrl, alt, shift, meta }, or null when the key is not one
 * we can match.
 */
function parseAccelerator(accelerator) {
  if (!UiohookKey) return null; // no native module: nothing can match
  if (!accelerator || typeof accelerator !== 'string') return null;
  const parts = accelerator.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const spec = { keycode: null, ctrl: false, alt: false, shift: false, meta: false };
  for (const part of parts) {
    const token = part.toUpperCase();
    if (MODIFIER_TOKENS.has(token)) {
      if (token === 'ALT') spec.alt = true;
      else if (token === 'SHIFT') spec.shift = true;
      else if (token === 'SUPER' || token === 'META' || token === 'CMD' || token === 'COMMAND') spec.meta = true;
      else spec.ctrl = true; // Ctrl / Control / CommandOrControl
      continue;
    }
    // The non-modifier token is the key itself; a second one is malformed.
    if (spec.keycode !== null) return null;
    const name = TOKEN_TO_UIOHOOK[token] || token;
    const keycode = UiohookKey[name] !== undefined ? UiohookKey[name] : UiohookKey[part.toUpperCase()];
    if (keycode === undefined) return null;
    spec.keycode = keycode;
  }
  return spec.keycode === null ? null : spec;
}

/**
 * Does a uiohook keydown event satisfy this spec? Modifiers must match
 * exactly: "B" means B with nothing held, so Ctrl+B does not fire it and you
 * can still use Ctrl+B elsewhere.
 */
function eventMatches(spec, event) {
  if (!spec || !event) return false;
  return (
    event.keycode === spec.keycode &&
    Boolean(event.ctrlKey) === spec.ctrl &&
    Boolean(event.altKey) === spec.alt &&
    Boolean(event.shiftKey) === spec.shift &&
    Boolean(event.metaKey) === spec.meta
  );
}

/**
 * Resolves which binding an event fires, given { name: accelerator }.
 * Pure — this is what the tests drive.
 */
function matchBinding(bindings, event) {
  for (const [name, accelerator] of Object.entries(bindings || {})) {
    const spec = parseAccelerator(accelerator);
    if (spec && eventMatches(spec, event)) return name;
  }
  return null;
}

/**
 * Starts the hook. `bindings` is { name: accelerator }; `onFire(name)` runs on
 * a match. Returns a handle with stop() and update(bindings).
 *
 * Never throws: a hook that cannot start (no X11, macOS accessibility
 * permission not granted) must degrade to "keys do nothing", not take the app
 * down. Callers check `.ok`.
 */
function startKeyHook({ bindings = {}, onFire = () => {}, onLog = () => {} } = {}) {
  if (!isAvailable()) {
    onLog('pass-through keybinds unavailable: uiohook-napi is not installed on this platform');
    return { ok: false, stop() {}, update() {} };
  }
  let current = { ...bindings };
  let running = false;
  let uIOhook;

  const handler = (event) => {
    const name = matchBinding(current, event);
    // Deliberately no logging of the event itself — see the privacy note.
    if (name) onFire(name);
  };

  try {
    ({ uIOhook } = require('uiohook-napi'));
    uIOhook.on('keydown', handler);
    uIOhook.start();
    running = true;
    onLog(`pass-through keybinds active (${Object.keys(current).length} bound)`);
  } catch (err) {
    onLog(`pass-through keybinds unavailable: ${err.message}`);
    return { ok: false, stop() {}, update() {} };
  }

  return {
    ok: true,
    update(next) {
      current = { ...next };
    },
    stop() {
      if (!running) return;
      running = false;
      try {
        uIOhook.off('keydown', handler);
        uIOhook.stop();
      } catch (err) {
        onLog(`stopping the hook failed: ${err.message}`);
      }
    },
  };
}

module.exports = { startKeyHook, parseAccelerator, eventMatches, matchBinding, isAvailable };
