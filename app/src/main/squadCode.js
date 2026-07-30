'use strict';

// One string replaces the relay URL field and the token field (BRIEF §3).
//
//   IB1-Z2FiLXBjLnRhaWw5ZjJiLnRzLm5ldDo4MTQwOmtkOTM
//    │   └── base64url( host ":" port ":" token ), padding stripped
//    └────── format prefix + version
//
// The prefix exists so a client can reject junk BEFORE opening a socket:
// validate, then connect — never the other way round.
//
// THE CODE IS A PASSWORD. It embeds the shared token, so it must never be
// logged, put in a crash report, or pasted into the log tail on the LOG page.
//
// This changes how a client is CONFIGURED. Not one byte on the wire changes —
// PROTOCOL.md remains the source of truth for that.

const PREFIX = 'IB1-';

// Rejecting a too-short token at generation time is cheap; the alternative is
// a squad whose "password" is four guessable characters.
const MIN_TOKEN_LENGTH = 12;

function encodeSquadCode(host, port, token) {
  if (!host || String(host).includes(':')) throw new Error('host must be set and contain no colon');
  if (!/^\d+$/.test(String(port))) throw new Error('port must be numeric');
  if (!token || String(token).includes(':')) throw new Error('token must be set and contain no colon');
  return (
    PREFIX +
    Buffer.from(`${host}:${port}:${token}`, 'utf8').toString('base64url').replace(/=+$/, '')
  );
}

/**
 * Decodes a squad code, or throws. Callers that render UI should use
 * tryDecodeSquadCode() instead — a bad code must populate nothing and disable
 * CONNECT, never throw into the console leaving the UI looking fine.
 */
function decodeSquadCode(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s.startsWith(PREFIX)) throw new Error('not a squad code');
  const b = s.slice(PREFIX.length);
  if (!b) throw new Error('malformed squad code');
  if (!/^[A-Za-z0-9_-]+$/.test(b)) throw new Error('malformed squad code');

  const json = Buffer.from(b + '='.repeat((4 - (b.length % 4)) % 4), 'base64url').toString('utf8');
  // Split from the RIGHT: hosts contain dots, but neither the port nor the
  // token may contain a colon, so the last two colons are the real delimiters.
  const i = json.lastIndexOf(':');
  const j = json.lastIndexOf(':', i - 1);
  if (i < 0 || j < 0) throw new Error('malformed squad code');

  const host = json.slice(0, j);
  const port = json.slice(j + 1, i);
  const token = json.slice(i + 1);
  if (!host || !/^\d+$/.test(port) || !token) throw new Error('malformed squad code');
  const portNum = Number(port);
  if (portNum < 1 || portNum > 65535) throw new Error('malformed squad code');
  return { host, port: portNum, token };
}

/** Non-throwing form for the JOIN page: { ok, host, port, token } | { ok:false, error }. */
function tryDecodeSquadCode(raw) {
  try {
    return { ok: true, ...decodeSquadCode(raw) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * The ws:// URL a decoded code connects to. Tailscale Funnel terminates TLS on
 * :443, so a code pointing at 443 means wss://; anything else is a plain
 * LAN/localhost relay.
 */
function relayUrlFor({ host, port }) {
  return port === 443 ? `wss://${host}` : `ws://${host}:${port}`;
}

/** A fresh token of a length worth calling a secret (BRIEF §3 / ROADMAP §1). */
function generateToken(bytes = 12) {
  return require('crypto').randomBytes(bytes).toString('base64url').replace(/=+$/, '');
}

/** For display: never show the whole token, it is half the password. */
function maskToken(token) {
  const t = String(token || '');
  return t.length <= 4 ? '••••' : `•••• ${t.slice(-4).toUpperCase()}`;
}

module.exports = {
  encodeSquadCode,
  decodeSquadCode,
  tryDecodeSquadCode,
  relayUrlFor,
  generateToken,
  maskToken,
  PREFIX,
  MIN_TOKEN_LENGTH,
};
