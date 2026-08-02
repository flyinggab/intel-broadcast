'use strict';

// The realtime (`/rt`) socket brief mode runs on. Plain Node against a real
// relayServer — no Electron, no windows.
//
// Usage: node scripts/dev-brief-relay-test.js
//
// What this is really guarding: the relay is the ONE place that can stop a
// malformed or hostile frame from reaching every pilot's screen at once. If
// presenter enforcement or identity stamping is wrong here, any client on the
// net can page everyone else's kneeboard or draw on it while wearing someone
// else's callsign.

const assert = require('assert');
const WebSocket = require('ws');
const { createRelayServer } = require('../src/main/relayServer');
const { REALTIME_PATH } = require('../src/main/protocol');

const PORT = 8899;
const TOKEN = 'brief-test-secret';
const HASH = 'a'.repeat(64);
const BAD_HASH = 'nothex';

const log = [];
const server = createRelayServer({ port: PORT, token: TOKEN, onLog: (m) => log.push(m) });

/**
 * Opens a socket, does the auth handshake, resolves once authenticated.
 *
 * A successful auth has no reply frame — the server just stops closing the
 * socket. So "authenticated" is judged by the socket still being open a beat
 * later, and a rejection by it having been closed. Resolving on the timer
 * alone would report every failed auth as a success, which is exactly the
 * hole this test exists to close.
 */
function connect(callsign, { path = REALTIME_PATH, token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    const inbox = [];
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type !== 'hello-ack') inbox.push(msg);
    });
    ws.on('error', fail);
    ws.on('close', (code) => fail(new Error(`refused, close code ${code}`)));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', role: 'viewer', token, callsign }));
      setTimeout(() => {
        if (settled) return;
        if (ws.readyState !== WebSocket.OPEN) return fail(new Error('closed during auth'));
        settled = true;
        resolve({ ws, inbox, callsign });
      }, 200);
    });
  });
}

const send = (c, msg) => c.ws.send(JSON.stringify(msg));
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // -------------------------------------------------------------------------
  // Routing: one port, two sockets, and nothing else.
  // -------------------------------------------------------------------------
  {
    const bulk = await connect('BULK', { path: '/' });
    assert.strictEqual(bulk.ws.readyState, WebSocket.OPEN, '/ still reaches the bulk socket');
    bulk.ws.close();

    await assert.rejects(
      () => connect('NOPE', { path: '/wrong' }),
      'an unknown path is refused, not silently accepted',
    );
    console.log('[test] / routes to bulk, /rt to realtime, anything else is refused');
  }

  // -------------------------------------------------------------------------
  // A second socket must not be a second way in.
  // -------------------------------------------------------------------------
  {
    await assert.rejects(
      () => connect('THIEF', { token: 'wrong-token' }),
      'the realtime socket enforces the same token',
    );
    console.log('[test] realtime auth rejects a bad token');
  }

  // -------------------------------------------------------------------------
  // Presenter enforcement and identity stamping.
  // -------------------------------------------------------------------------
  {
    const host = await connect('GHOSTRIDER 1-1');
    const pilot = await connect('JOKER 2-1');

    // Before anyone presents, a stroke from any client goes nowhere.
    send(pilot, { type: 'brief-stroke', hash: HASH, id: 'x', points: [{ u: 1, v: 1 }] });
    await settle();
    assert.strictEqual(host.inbox.length, 0, 'no presenter means no ink reaches anyone');

    send(host, { type: 'brief-present-start' });
    await settle();
    assert.strictEqual(pilot.inbox.at(-1).type, 'brief-present-start');
    assert.strictEqual(pilot.inbox.at(-1).presenter, 'GHOSTRIDER 1-1', 'the arrival is named');
    assert.strictEqual(server.getPresenter(), 'GHOSTRIDER 1-1');

    // The non-presenter still cannot draw on everyone's kneeboard.
    pilot.inbox.length = 0;
    host.inbox.length = 0;
    send(pilot, { type: 'brief-stroke', hash: HASH, id: 'sneaky', points: [{ u: 5, v: 5 }] });
    send(pilot, { type: 'brief-focus', hash: HASH, batchId: 'b', filename: 'f.jpg' });
    await settle();
    assert.strictEqual(host.inbox.length, 0, 'a non-presenter cannot draw');
    assert.strictEqual(pilot.inbox.length, 0, 'nor page anyone');

    // Identity is taken from the authenticated socket, never the frame — a
    // client cannot present as someone else by editing a field.
    send(host, { type: 'brief-stroke', hash: HASH, id: 's1', presenter: 'SOMEONE ELSE', points: [{ u: 10, v: 20 }] });
    await settle();
    const stroke = pilot.inbox.at(-1);
    assert.strictEqual(stroke.type, 'brief-stroke');
    assert.strictEqual(stroke.presenter, 'GHOSTRIDER 1-1', 'a spoofed presenter field is overwritten');
    assert.deepStrictEqual(stroke.points, [{ u: 10, v: 20 }]);
    console.log('[test] only the presenter drives the brief, and identity is stamped server-side');

    // ----------------------------------------------------------------------
    // A late joiner must not sit blank until the presenter happens to page.
    // ----------------------------------------------------------------------
    send(host, { type: 'brief-focus', hash: HASH, batchId: 'batch-1', filename: '02-secondary.jpg' });
    await settle();

    const late = await connect('UZI 1-1');
    await settle();
    const types = late.inbox.map((m) => m.type);
    assert.ok(types.includes('brief-present-start'), 'a late joiner is told a brief is running');
    assert.ok(types.includes('brief-focus'), 'and which image it is on');
    assert.strictEqual(late.inbox.find((m) => m.type === 'brief-focus').hash, HASH);
    console.log('[test] a late joiner is caught up on connect');

    // ----------------------------------------------------------------------
    // Malformed frames are dropped at the relay, never forwarded.
    // ----------------------------------------------------------------------
    pilot.inbox.length = 0;
    send(host, { type: 'brief-focus', hash: BAD_HASH });
    send(host, { type: 'brief-stroke', hash: HASH, id: 'f', points: [{ u: 1.5, v: 2 }] }); // float
    send(host, { type: 'brief-stroke', hash: HASH, id: 'f', points: [{ u: -1, v: 2 }] }); // negative
    send(host, { type: 'brief-stroke', hash: HASH, id: 'f', points: [{ u: 99999, v: 2 }] }); // over u16
    send(host, { type: 'brief-shape', hash: HASH, id: 't', tool: 'text', a: { u: 1, v: 1 }, b: { u: 2, v: 2 } });
    send(host, { type: 'brief-nonsense', hash: HASH });
    host.ws.send('{not json');
    await settle();
    assert.strictEqual(pilot.inbox.length, 0, 'not one malformed frame reached another pilot');
    console.log('[test] malformed frames die at the relay');

    // Shapes upsert; the wire carries whole geometry every frame.
    pilot.inbox.length = 0;
    send(host, { type: 'brief-shape', hash: HASH, id: 'r1', tool: 'ring', a: { u: 100, v: 100 }, b: { u: 200, v: 100 } });
    send(host, { type: 'brief-shape', hash: HASH, id: 'r1', tool: 'ring', a: { u: 100, v: 100 }, b: { u: 300, v: 100 }, final: true });
    await settle();
    assert.strictEqual(pilot.inbox.length, 2, 'each shape frame is forwarded');
    assert.strictEqual(pilot.inbox.at(-1).final, true, 'release is carried');
    console.log('[test] shape upserts carry full geometry and a final flag');

    // ----------------------------------------------------------------------
    // The presenter's socket dropping ends the brief, rather than leaving
    // every other pilot following a ghost.
    // ----------------------------------------------------------------------
    pilot.inbox.length = 0;
    host.ws.close();
    await settle(300);
    assert.strictEqual(server.getPresenter(), null, 'a disconnected presenter stops presenting');
    assert.strictEqual(pilot.inbox.at(-1).type, 'brief-present-stop', 'and everyone is told');
    console.log('[test] a presenter disconnect ends the brief and says so');

    pilot.ws.close();
    late.ws.close();
  }

  await settle();
  await new Promise((resolve) => server.close(resolve));
  console.log('[dev-brief-relay-test] PASS');
}

main().catch((err) => {
  console.error(`[dev-brief-relay-test] FAIL: ${err.message}`);
  console.error(log.slice(-10).join('\n'));
  server.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 1000);
});
