'use strict';

// Unit test for squadCode.js. The test vector in BRIEF §3 must round-trip
// exactly — it is the interop contract for anything that ever generates a code.
//
// Usage: node scripts/dev-squad-code-test.js

const assert = require('assert');
const {
  encodeSquadCode,
  decodeSquadCode,
  tryDecodeSquadCode,
  relayUrlFor,
  generateToken,
  maskToken,
  MIN_TOKEN_LENGTH,
} = require('../src/main/squadCode');

// --- The BRIEF's test vector, both directions -------------------------------
const VECTOR = 'IB1-Z2FiLXBjLnRhaWw5ZjJiLnRzLm5ldDo4MTQwOmtkOTM';
const HOST = 'gab-pc.tail9f2b.ts.net';
const PORT = 8140;
const TOKEN = 'kd93';

assert.strictEqual(encodeSquadCode(HOST, PORT, TOKEN), VECTOR, 'encode must match the brief vector');
assert.deepStrictEqual(decodeSquadCode(VECTOR), { host: HOST, port: PORT, token: TOKEN });
console.log('[test] brief test vector round-trips exactly');

// --- Splitting from the right -----------------------------------------------
// Hosts contain dots; the token must survive whatever it looks like as long as
// it has no colon.
for (const token of ['kd93', 'A1-b2_c3', 'zzz', 'has.dots.in.it', '9999']) {
  const code = encodeSquadCode('a.b.c.ts.net', 443, token);
  assert.deepStrictEqual(decodeSquadCode(code), { host: 'a.b.c.ts.net', port: 443, token });
}
console.log('[test] right-split survives dotted hosts and awkward tokens');

// --- Rejection before a socket is ever opened -------------------------------
const BAD = [
  '',
  '   ',
  'IB1-',
  'not-a-code',
  'IB2-Z2FiLXBj', // wrong version prefix
  'ib1-Z2FiLXBj', // prefix is case-sensitive
  VECTOR.slice(0, 20), // truncated — the case the brief calls out by name
  VECTOR + '!!!', // invalid base64url characters
  'IB1-' + Buffer.from('nocolons').toString('base64url'),
  'IB1-' + Buffer.from('host:notaport:tok').toString('base64url'),
  'IB1-' + Buffer.from('host:99999:tok').toString('base64url'), // out of range
  'IB1-' + Buffer.from(':8140:tok').toString('base64url'), // empty host
  'IB1-' + Buffer.from('host:8140:').toString('base64url'), // empty token
];
for (const bad of BAD) {
  assert.throws(() => decodeSquadCode(bad), `expected "${bad}" to be rejected`);
  const attempt = tryDecodeSquadCode(bad);
  assert.strictEqual(attempt.ok, false, `tryDecode should report failure for "${bad}"`);
  assert.ok(attempt.error, 'a failure carries a reason');
}
// The non-throwing form is what the JOIN page uses: it must never throw, so a
// bad paste disables CONNECT instead of leaving the UI looking fine.
assert.strictEqual(tryDecodeSquadCode(null).ok, false);
assert.strictEqual(tryDecodeSquadCode(undefined).ok, false);
assert.strictEqual(tryDecodeSquadCode(12345).ok, false);
console.log('[test] junk is rejected before any socket is opened');

// --- Whitespace from a real paste --------------------------------------------
assert.deepStrictEqual(decodeSquadCode(`  ${VECTOR}\n`), { host: HOST, port: PORT, token: TOKEN });
console.log('[test] pasted whitespace tolerated');

// --- Encoder input validation -------------------------------------------------
assert.throws(() => encodeSquadCode('has:colon', 8140, 'tok'), /colon/);
assert.throws(() => encodeSquadCode('host', 'notaport', 'tok'), /numeric/);
assert.throws(() => encodeSquadCode('host', 8140, 'has:colon'), /colon/);
assert.throws(() => encodeSquadCode('', 8140, 'tok'), /host/);
console.log('[test] encoder rejects unencodable input');

// --- URL derivation -----------------------------------------------------------
assert.strictEqual(relayUrlFor({ host: 'x.ts.net', port: 443 }), 'wss://x.ts.net');
assert.strictEqual(relayUrlFor({ host: 'localhost', port: 8787 }), 'ws://localhost:8787');
console.log('[test] 443 implies wss (funnel), anything else plain ws');

// --- Generated tokens are actually secrets -------------------------------------
const generated = generateToken();
assert.ok(generated.length >= MIN_TOKEN_LENGTH, `generated token too short: ${generated.length}`);
assert.ok(!generated.includes(':'), 'generated token must be encodable');
assert.notStrictEqual(generateToken(), generateToken(), 'tokens must not repeat');
assert.deepStrictEqual(decodeSquadCode(encodeSquadCode(HOST, PORT, generated)).token, generated);
console.log('[test] generated tokens are long, unique and encodable');

// --- Masking never reveals the whole token --------------------------------------
assert.ok(!maskToken('supersecrettoken').includes('supersecret'));
assert.strictEqual(maskToken('ab'), '••••');
console.log('[test] token masking OK');

console.log('[dev-squad-code-test] PASS');
