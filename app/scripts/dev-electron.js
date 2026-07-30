'use strict';

const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');

/**
 * Launches the app for a test.
 *
 * `node_modules/.bin/electron` is a *Node shim* that spawns the real binary as
 * its own child, so `child.kill()` only ever kills the shim — the actual
 * Electron process survives, leaving a window on the desktop (this is a WSLg
 * sandbox: those are real windows on the user's screen) that then squats its
 * relay port and fails whichever test runs next with EADDRINUSE.
 *
 * `detached: true` puts the shim and everything it spawns into one process
 * group, which signalApp()/killApp() can take down with a single signal.
 */
function spawnApp({ env = {}, args = ['.', '--no-sandbox'] } = {}) {
  return spawn(ELECTRON_BIN, args, {
    cwd: APP_DIR,
    detached: true,
    env: { ...process.env, ...env },
  });
}

/**
 * Signals the app's whole process group (negative pid == group).
 *
 * Use this for FORCE kills only. For a graceful shutdown, signal the direct
 * child instead (`child.kill('SIGTERM')`) — the shim forwards it and the real
 * binary runs its normal quit path; signalling the group takes the shim down
 * at the same moment and Electron's cleanup handlers get cut short.
 */
function signalApp(child, signal = 'SIGTERM') {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group already gone, or never started — fall back to the direct child
    try {
      child.kill(signal);
    } catch {
      // nothing left to signal
    }
  }
}

/** Force-kills the app and everything it spawned. Safe to call twice. */
function killApp(child) {
  signalApp(child, 'SIGKILL');
}

module.exports = { spawnApp, signalApp, killApp, APP_DIR, ELECTRON_BIN };
