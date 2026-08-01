'use strict';

const crypto = require('crypto');

const AUTH_TIMEOUT_MS = 5000;
const CLOSE_AUTH_FAILED = 4001;
const CLOSE_AUTH_TIMEOUT_OR_MALFORMED = 4002;
const CLOSE_RATE_LIMITED = 4003;

// Per-IP attempt limiting (ROADMAP §1). The token is a shared squad secret,
// not a hard security boundary, but nothing should let an open funnel be
// brute-forced at line rate.
const MAX_FAILURES_PER_WINDOW = 10;
const FAILURE_WINDOW_MS = 60 * 1000;

const failures = new Map(); // ip -> { count, firstAt }

function noteFailure(ip) {
  if (!ip) return;
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || now - entry.firstAt > FAILURE_WINDOW_MS) {
    failures.set(ip, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

function isRateLimited(ip) {
  if (!ip) return false;
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > FAILURE_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES_PER_WINDOW;
}

function clearFailures(ip) {
  if (ip) failures.delete(ip);
}

/**
 * Constant-time token comparison. A plain `!==` leaks the length of the
 * matching prefix through timing; timingSafeEqual needs equal-length buffers,
 * so both sides are hashed first (which also makes the comparison
 * length-independent).
 */
function tokensMatch(given, expected) {
  const a = crypto.createHash('sha256').update(String(given == null ? '' : given)).digest();
  const b = crypto.createHash('sha256').update(String(expected == null ? '' : expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Waits for a freshly-connected socket to authenticate.
 *
 * Accepts an optional `HELLO` control frame BEFORE the auth frame. v1 has no
 * version field anywhere, so until one exists no later protocol change is
 * safe; a v1 server that simply tolerates and answers HELLO costs nothing now
 * and is what makes phase 2 possible (see PROTOCOL-V2.md §3). Unknown control
 * frames are ignored rather than fatal, for the same reason.
 */
function authenticateConnection(ws, expectedToken, { onLog = () => {} } = {}) {
  const ip = ws && ws._socket && ws._socket.remoteAddress;

  return new Promise((resolve, reject) => {
    if (isRateLimited(ip)) {
      ws.close(CLOSE_RATE_LIMITED, 'too many failed attempts');
      reject(new Error(`rate limited: ${ip}`));
      return;
    }

    const timer = setTimeout(() => {
      ws.close(CLOSE_AUTH_TIMEOUT_OR_MALFORMED, 'auth timeout');
      reject(new Error('auth timeout'));
    }, AUTH_TIMEOUT_MS);

    function fail(code, message) {
      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      if (code === CLOSE_AUTH_FAILED) noteFailure(ip);
      ws.close(code, message);
      reject(new Error(message));
    }

    function onMessage(data, isBinary) {
      if (isBinary) return fail(CLOSE_AUTH_TIMEOUT_OR_MALFORMED, 'expected auth frame, got binary');

      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return fail(CLOSE_AUTH_TIMEOUT_OR_MALFORMED, 'malformed auth frame');
      }

      // Optional pre-auth handshake. This is the version field v1 lacks.
      if (msg && msg.type === 'hello') {
        try {
          ws.send(
            JSON.stringify({
              type: 'hello-ack',
              protocolVersion: 1,
              server: `taclink-electron/${process.env.npm_package_version || '0'}`,
              capabilities: [],
            }),
          );
        } catch {
          // a client that vanished mid-handshake is not our problem
        }
        onLog(`hello from ${msg.client || 'unknown client'} (protocol ${msg.protocolVersion || '?'})`);
        return; // keep waiting for the auth frame
      }

      if (!msg || msg.type !== 'auth' || (msg.role !== 'viewer' && msg.role !== 'gm')) {
        return fail(CLOSE_AUTH_TIMEOUT_OR_MALFORMED, 'malformed auth frame');
      }
      if (!tokensMatch(msg.token, expectedToken)) {
        return fail(CLOSE_AUTH_FAILED, 'auth failed');
      }

      clearTimeout(timer);
      ws.removeListener('message', onMessage);
      clearFailures(ip);
      resolve(msg);
    }

    ws.on('message', onMessage);
  });
}

module.exports = {
  authenticateConnection,
  tokensMatch,
  AUTH_TIMEOUT_MS,
  CLOSE_AUTH_FAILED,
  CLOSE_AUTH_TIMEOUT_OR_MALFORMED,
  CLOSE_RATE_LIMITED,
  MAX_FAILURES_PER_WINDOW,
  _resetFailures: () => failures.clear(),
};
