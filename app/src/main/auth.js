'use strict';

const AUTH_TIMEOUT_MS = 5000;
const CLOSE_AUTH_FAILED = 4001;
const CLOSE_AUTH_TIMEOUT_OR_MALFORMED = 4002;

/**
 * Waits for the first frame on a freshly-connected socket to be a valid
 * `{type:"auth", token, role, callsign}` message matching `expectedToken`.
 * Resolves with the parsed auth message, or closes the socket and rejects.
 */
function authenticateConnection(ws, expectedToken) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close(CLOSE_AUTH_TIMEOUT_OR_MALFORMED, 'auth timeout');
      reject(new Error('auth timeout'));
    }, AUTH_TIMEOUT_MS);

    ws.once('message', (data, isBinary) => {
      clearTimeout(timer);

      if (isBinary) {
        ws.close(CLOSE_AUTH_TIMEOUT_OR_MALFORMED, 'expected auth frame, got binary');
        reject(new Error('expected auth frame, got binary'));
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        ws.close(CLOSE_AUTH_TIMEOUT_OR_MALFORMED, 'malformed auth frame');
        reject(new Error('malformed auth frame'));
        return;
      }

      if (msg.type !== 'auth' || (msg.role !== 'viewer' && msg.role !== 'gm')) {
        ws.close(CLOSE_AUTH_TIMEOUT_OR_MALFORMED, 'malformed auth frame');
        reject(new Error('malformed auth frame'));
        return;
      }

      if (msg.token !== expectedToken) {
        ws.close(CLOSE_AUTH_FAILED, 'auth failed');
        reject(new Error('auth failed'));
        return;
      }

      resolve(msg);
    });
  });
}

module.exports = { authenticateConnection, AUTH_TIMEOUT_MS, CLOSE_AUTH_FAILED, CLOSE_AUTH_TIMEOUT_OR_MALFORMED };
