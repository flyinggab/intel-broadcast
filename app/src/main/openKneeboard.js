'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Relays page turns to OpenKneeboard so ONE key drives both kneeboards.
//
// WHY NOT JUST SHARE THE HOTKEY: on Windows a global hotkey is exclusive.
// `RegisterHotKey` — which Electron's globalShortcut uses — fails outright if
// another process already owns the combination, and the OS does this on
// purpose so applications cannot fight over keys. So "both apps see the same
// keypress" is not something two well-behaved apps can arrange between them:
// exactly one owns it. (The alternative is a WH_KEYBOARD_LL hook, which
// observes keys without consuming them — but that needs a native module, and
// this project has kept itself free of those precisely so the release
// pipeline stays a plain `npm ci` on CI.)
//
// So: this app owns the key, and forwards the same intent onward. That is the
// integration OpenKneeboard documents for StreamDeck, Huion tablets and
// anything else driving it — a set of tiny executables that message the
// running instance.
//
// Pure Node, no Electron: unit-testable, and the binary path is injectable.

const COMMANDS = {
  next: 'OpenKneeboard-RemoteControl-NEXT_PAGE.exe',
  prev: 'OpenKneeboard-RemoteControl-PREVIOUS_PAGE.exe',
};

function wellKnownDirs() {
  if (process.platform !== 'win32') return [];
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    path.join(programFiles, 'OpenKneeboard', 'utilities'),
    path.join(programFilesX86, 'OpenKneeboard', 'utilities'),
  ];
}

/**
 * The folder holding the remote-control executables, or null. The env override
 * exists for tests (and for an install somewhere unusual).
 */
function findUtilitiesDir() {
  // "Installed" means the executable we would actually run is there — for the
  // override too, not just the well-known paths. Keying the override on the
  // folder alone would let isAvailable() report true while every dispatch
  // silently did nothing.
  const candidates = process.env.INTEL_BROADCAST_OKB_UTILITIES
    ? [process.env.INTEL_BROADCAST_OKB_UTILITIES]
    : wellKnownDirs();
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, COMMANDS.next))) return dir;
  }
  return null;
}

function isAvailable() {
  return findUtilitiesDir() !== null;
}

/**
 * Fires a page turn at OpenKneeboard. Deliberately fire-and-forget: this runs
 * on the hotkey path, and a pilot's page turn must never wait on a process
 * spawn. Returns whether a command was dispatched at all.
 *
 * Harmless when OpenKneeboard is not running — the executable messages a
 * missing instance and exits.
 */
function sendPage(direction, { onLog = () => {} } = {}) {
  const exe = COMMANDS[direction];
  if (!exe) return false;
  const dir = findUtilitiesDir();
  if (!dir) return false;

  try {
    const child = spawn(path.join(dir, exe), [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // Unref so a page turn can never hold the app open at quit.
    child.unref();
    child.on('error', (err) => onLog(`openkneeboard ${direction} failed: ${err.message}`));
    return true;
  } catch (err) {
    onLog(`openkneeboard ${direction} failed: ${err.message}`);
    return false;
  }
}

module.exports = { findUtilitiesDir, isAvailable, sendPage, COMMANDS };
