'use strict';

const fs = require('fs');
const path = require('path');

// Packaged Windows/Mac builds run without a console attached, so everything
// the app logs is invisible exactly when it matters — a user reporting "I
// ticked the box and nothing happened" has nothing to send back. Mirror
// console output into a file in userData that the Settings window can open.

const MAX_BYTES = 1024 * 1024;

let stream = null;
let filePath = null;

/** Starts mirroring console.log/warn/error to <userDataDir>/intel-broadcast.log. */
function initFileLogging(userDataDir) {
  filePath = path.join(userDataDir, 'intel-broadcast.log');
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    // Truncate rather than rotate — this is a debugging aid, not an audit
    // trail, and the most recent session is the one anyone ever wants.
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_BYTES) {
      fs.rmSync(filePath, { force: true });
    }
    stream = fs.createWriteStream(filePath, { flags: 'a' });
    stream.on('error', () => {
      stream = null; // disk full / permissions — never take the app down for a log
    });
  } catch {
    stream = null;
    return null;
  }

  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      write(level, args);
    };
  }

  console.log(`[log] session started ${new Date().toISOString()} — logging to ${filePath}`);
  return filePath;
}

function write(level, args) {
  if (!stream) return;
  try {
    const text = args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');
    stream.write(`${new Date().toISOString()} ${level.toUpperCase()} ${text}\n`);
  } catch {
    // a failed log write must never propagate
  }
}

function getLogFilePath() {
  return filePath;
}

module.exports = { initFileLogging, getLogFilePath };
