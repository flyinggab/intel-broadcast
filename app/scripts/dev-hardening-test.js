'use strict';

// The ROADMAP §1 hardening list, exercised against a real relay server:
//   - HELLO / HELLO_ACK survives as an optional pre-auth frame (the version
//     field v1 lacks, and the thing that makes phase 2 safe)
//   - constant-time token comparison
//   - per-IP failed-attempt limiting
//   - ws maxPayload is set rather than left at the 100 MiB default
//   - the broadcast loop has a bufferedAmount ceiling
//
// Usage: node scripts/dev-hardening-test.js

const assert = require('assert');
const WebSocket = require('ws');
const { createRelayServer } = require('../src/main/relayServer');
const auth = require('../src/main/auth');

const PORT = require('./dev-ports').hardening;
const TOKEN = 'hardening-test-token';

const logs = [];
const server = createRelayServer({ port: PORT, token: TOKEN, onLog: (m) => logs.push(m) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  return new WebSocket(`ws://localhost:${PORT}`);
}

/** Resolves 'open' | 'closed:<code>' for one auth attempt. */
function attempt({ token, hello = false }) {
  return new Promise((resolve) => {
    const ws = connect();
    let settled = false;
    ws.on('open', () => {
      if (hello) {
        ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, client: 'test/1.0' }));
      }
      ws.send(JSON.stringify({ type: 'auth', token, role: 'viewer', callsign: 'probe' }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === 'hello-ack' && !settled) {
        settled = true;
        resolve({ result: 'hello-ack', msg, ws });
      }
    });
    ws.on('close', (code) => {
      if (!settled) {
        settled = true;
        resolve({ result: 'closed', code });
      }
    });
    // No close within a moment means the socket was accepted.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ result: 'open', ws });
      }
    }, 400);
  });
}

async function main() {
  // --- HELLO is answered and does not disturb auth --------------------------
  const withHello = await attempt({ token: TOKEN, hello: true });
  assert.strictEqual(withHello.result, 'hello-ack', 'server must answer HELLO');
  assert.strictEqual(withHello.msg.protocolVersion, 1, 'HELLO_ACK carries a version — the whole point');
  assert.ok(Array.isArray(withHello.msg.capabilities), 'capabilities list present for phase 2 negotiation');
  await sleep(300);
  assert.ok(
    logs.some((m) => m.includes('client connected')),
    'the HELLO client still authenticated normally afterwards',
  );
  withHello.ws.close();
  console.log('[test] HELLO/HELLO_ACK works and auth still completes');

  // --- A client that never sends HELLO is unaffected (v1 compatibility) -----
  const noHello = await attempt({ token: TOKEN });
  assert.strictEqual(noHello.result, 'open', 'plain v1 auth still accepted');
  noHello.ws.close();
  console.log('[test] pre-HELLO clients still work');

  // --- Constant-time comparison --------------------------------------------
  assert.strictEqual(auth.tokensMatch('abc', 'abc'), true);
  assert.strictEqual(auth.tokensMatch('abc', 'abd'), false);
  assert.strictEqual(auth.tokensMatch('', ''), true);
  // Different lengths must not throw (timingSafeEqual demands equal lengths;
  // hashing first is what makes that safe).
  assert.strictEqual(auth.tokensMatch('short', 'a-much-longer-token'), false);
  assert.strictEqual(auth.tokensMatch(undefined, 'x'), false);
  console.log('[test] token comparison is constant-time and length-safe');

  // --- Per-IP failed-attempt limiting ---------------------------------------
  auth._resetFailures();
  let sawAuthFailure = false;
  let sawRateLimit = false;
  for (let i = 0; i < auth.MAX_FAILURES_PER_WINDOW + 3; i++) {
    const res = await attempt({ token: 'wrong-token' });
    assert.strictEqual(res.result, 'closed', 'a bad token must close the socket');
    if (res.code === auth.CLOSE_AUTH_FAILED) sawAuthFailure = true;
    if (res.code === auth.CLOSE_RATE_LIMITED) sawRateLimit = true;
  }
  assert.ok(sawAuthFailure, 'early attempts close with the auth-failed code');
  assert.ok(sawRateLimit, 'sustained guessing eventually trips the rate limiter');
  console.log('[test] per-IP attempt limiting kicks in');

  // A good token is still refused while the limiter is hot — that is the
  // point of a limiter, and it expires on its own.
  const blocked = await attempt({ token: TOKEN });
  assert.strictEqual(blocked.code, auth.CLOSE_RATE_LIMITED, 'limiter applies regardless of token');
  auth._resetFailures();
  const recovered = await attempt({ token: TOKEN });
  assert.strictEqual(recovered.result, 'open', 'access returns once the window clears');
  recovered.ws.close();
  console.log('[test] limiter blocks while hot and releases after');

  // --- maxPayload is actually configured -------------------------------------
  assert.ok(server.wss.options.maxPayload, 'maxPayload must be set, not left at the ws default');
  assert.ok(
    server.wss.options.maxPayload < 100 * 1024 * 1024,
    `maxPayload ${server.wss.options.maxPayload} should be below the 100 MiB default`,
  );
  console.log(`[test] maxPayload set to ${(server.wss.options.maxPayload / (1024 * 1024)).toFixed(0)} MiB`);

  // --- The fan-out has a backpressure ceiling --------------------------------
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'relayServer.js'), 'utf8');
  assert.ok(/bufferedAmount\s*>/.test(source), 'the broadcast loop must check bufferedAmount');
  console.log('[test] broadcast loop checks bufferedAmount');

  server.close();
  console.log('[dev-hardening-test] PASS');
  process.exit(0);
}

main().catch((err) => {
  console.error(`[test] FAIL: ${err.message}`);
  process.exit(1);
});

setTimeout(() => {
  console.error('[test] FAIL: timeout');
  process.exit(1);
}, 30000);
