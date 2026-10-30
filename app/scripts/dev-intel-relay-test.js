#!/usr/bin/env node
'use strict';

// The headless relay end to end: its config, --init and --squad-code, then the
// real process following a dcs.log and the app's own RelayClient receiving
// what the mission wrote. Plus the limits a relay on a public port needs.
//
// Plain node, no Electron, no DCS. Everything listens on 127.0.0.1 only.
//
// Usage: node scripts/dev-intel-relay-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const { RelayClient } = require('../src/main/relayClient');
const { createRelayServer } = require('../src/main/relayServer');
const { decodeSquadCode } = require('../src/main/squadCode');
const { REALTIME_PATH } = require('../src/main/protocol');
const { loadConfig } = require('../src/relay/taclink-relay');

const RELAY = path.join(__dirname, '..', 'src', 'relay', 'taclink-relay.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'dcslog');
const PORT = 8911;
const LIMITS_PORT = 8912;
const HOST = 'relay.example.invalid'; // a placeholder: the code is decoded, never dialled

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = fn();
    if (v) return v;
    await settle(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'taclink-relay-'));
}

function run(args, cwd) {
  return spawnSync(process.execPath, [RELAY, ...args], { cwd, encoding: 'utf8', env: cleanEnv() });
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('TACLINK_RELAY_')) delete env[k];
  return env;
}

function client(callsign, token) {
  const c = new RelayClient({ url: `ws://127.0.0.1:${PORT}`, token, role: 'viewer', callsign });
  c.heard = [];
  c.refusedWith = null;
  c.on('brief', (m) => c.heard.push(m));
  c.on('refused', (r) => (c.refusedWith = r));
  c.connect();
  return c;
}
const intelOf = (c) => c.heard.filter((m) => m.type.startsWith('intel-'));
const lastRoster = (c) => [...c.heard].reverse().find((m) => m.type === 'net-roster');

function testConfig() {
  console.log('[test] config: a real token is required, the test one and port 443 are refused');
  const dir = tmpdir();
  const file = path.join(dir, 'taclink-relay.json');
  const write = (cfg) => fs.writeFileSync(file, JSON.stringify(cfg));
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('TACLINK_RELAY_')) delete process.env[k];
  try {
    assert.throws(() => loadConfig(file), /no token/);
    write({ token: 'short' });
    assert.throws(() => loadConfig(file), /at least 12/);
    write({ token: 'dev-secret' });
    assert.throws(() => loadConfig(file), /at least 12|test token/);
    write({ token: 'a-proper-token-here', port: 443 });
    assert.throws(() => loadConfig(file), /443/);
    write({ token: 'a-proper-token-here', limits: { nope: 1 } });
    assert.throws(() => loadConfig(file), /unknown limit/);
    write({ token: 'a-proper-token-here', dcsLog: '' });
    const cfg = loadConfig(file);
    assert.strictEqual(cfg.port, 8787, 'the default port');
    assert.strictEqual(cfg.dcsLog, '', 'an empty dcsLog turns the follower off');
    process.env.TACLINK_RELAY_PORT = '9100';
    process.env.TACLINK_RELAY_TOKEN = 'token-from-the-environment';
    const env = loadConfig(file);
    assert.strictEqual(env.port, 9100, 'the environment overrides the file');
    assert.strictEqual(env.token, 'token-from-the-environment');
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith('TACLINK_RELAY_')) delete process.env[k];
    Object.assign(process.env, saved);
  }

  console.log('[test] --init writes a fresh token once; --squad-code prints a code that decodes');
  const init = run(['--init'], dir);
  assert.strictEqual(init.status, 2, 'refuses to overwrite the file written above');
  fs.rmSync(file);
  const ok = run(['--init'], dir);
  assert.strictEqual(ok.status, 0, ok.stderr);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(written.token.length >= 24, 'a long token');
  assert.ok(!ok.stdout.includes(written.token), 'the token is not printed');
  const code = run(['--squad-code', HOST], dir);
  assert.strictEqual(code.status, 0, code.stderr);
  const decoded = decodeSquadCode(code.stdout.trim());
  assert.deepStrictEqual(decoded, { host: HOST, port: 8787, token: written.token });
  const check = run(['--check'], dir);
  assert.strictEqual(check.status, 0, check.stderr);
  assert.ok(!check.stdout.includes(written.token), '--check masks the token');
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testEndToEnd() {
  const dir = tmpdir();
  const dcsLog = path.join(dir, 'dcs.log');
  const relayLog = path.join(dir, 'relay.log');
  const token = 'end-to-end-test-token';
  fs.writeFileSync(
    path.join(dir, 'taclink-relay.json'),
    JSON.stringify({ port: PORT, host: '127.0.0.1', token, dcsLog, log: relayLog }),
  );
  const recorded = fs.readFileSync(path.join(FIXTURES, 'normal.log'), 'utf8').split('\n');
  // DCS already running when the relay starts: the header and the boot lines
  // are there, and must not be replayed.
  fs.writeFileSync(dcsLog, recorded.slice(0, 4).join('\n') + '\n');

  const proc = spawn(process.execPath, [RELAY], { cwd: dir, env: cleanEnv() });
  let out = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (out += d));
  const clients = [];
  try {
    await waitFor('the relay to listen', () => out.includes('listening on TCP'));
    await waitFor('the relay to follow dcs.log', () => out.includes('dcs.log: following'));

    console.log('[test] a pilot joins the headless relay and is on the roster');
    const a = client('JOKER 1-1', token);
    clients.push(a);
    await waitFor('JOKER on the roster', () => {
      const r = lastRoster(a);
      return r && r.peers.some((p) => p.callsign === 'JOKER 1-1');
    });

    console.log('[test] the mission writes its lines: one 9-line and two calls reach the pilot, once each');
    fs.appendFileSync(dcsLog, recorded.slice(4).join('\n'));
    await waitFor('three intel messages', () => intelOf(a).length >= 3);
    await settle(700); // a fourth would be the duplicate 0007, which must not come
    assert.deepStrictEqual(
      intelOf(a).map((m) => `${m.type} ${m.id}`),
      ['intel-nineline abu-musa-cas-test-0007', 'intel-call abu-musa-cas-test-0009', 'intel-call abu-musa-cas-test-0010'],
    );
    const nl = intelOf(a)[0];
    assert.strictEqual(nl.lines[5], 'N25 52.799 E055 02.596 (40R CP 04321 62345)');
    assert.strictEqual(nl.from, 'Pointer');
    assert.ok(/skipped a TACLINK line \(error: broken JSON\)/.test(out), 'the broken line is reported');

    console.log('[test] a pilot who joins late gets the roster and the mission\'s intel so far');
    const b = client('JOKER 1-2', token);
    clients.push(b);
    await waitFor('the catch-up', () => intelOf(b).length >= 3);
    assert.deepStrictEqual(intelOf(b).map((m) => m.id), intelOf(a).map((m) => m.id), 'oldest first, all of it');
    await waitFor('both on the roster', () => {
      const r = lastRoster(a);
      return r && r.peers.length === 2;
    });

    console.log('[test] a pilot cannot speak for DCS: intel sent by a client is refused');
    await waitFor('B realtime up', () => b.briefConnected);
    b.sendBrief({ type: 'intel-call', id: 'fake-1', mission: 'abu-musa-cas-test', from: 'Pointer', to: 'Joker', text: 'Abort, abort.' });
    await settle(400);
    assert.ok(!intelOf(a).some((m) => m.id === 'fake-1'), 'nobody hears it');
    assert.ok(out.includes('refused intel-call from JOKER 1-2'));

    console.log('[test] a mission reload clears the relay\'s memory: the same id goes out again');
    fs.appendFileSync(
      dcsLog,
      '2026-10-30 08:00:00.000 INFO    Dispatcher (Main): loadMission C:\\Missions\\abu-musa-cas-test.miz\n' +
        recorded.find((l) => l.includes('-0007')) +
        '\n',
    );
    await waitFor('0007 again', () => intelOf(a).filter((m) => m.id === 'abu-musa-cas-test-0007').length === 2);

    console.log('[test] DCS restarts: the old log is renamed, a new one is followed from its first line');
    fs.renameSync(dcsLog, path.join(dir, 'dcs.log.old'));
    await waitFor('the relay to see it gone', () => out.includes('is not there (yet)'));
    fs.writeFileSync(
      dcsLog,
      '=== Log opened UTC 2026-10-30 09:00:00\n' +
        '2026-10-30 09:05:00.000 INFO    SCRIPTING (Main): TACLINK: {"v":1,"kind":"call","id":"run2-0001","mission":"abu-musa-cas-test","from":"Pointer","to":"Joker","text":"New run, Pointer up."}\n',
    );
    await waitFor('the first call of the new run', () => intelOf(a).some((m) => m.id === 'run2-0001'));
    assert.ok(out.includes('DCS started a new log'));

    console.log('[test] a wrong token is refused, and the client stops instead of retrying');
    const bad = client('INTRUDER', 'not-the-right-token');
    clients.push(bad);
    await waitFor('the refusal', () => bad.refusedWith);
    assert.strictEqual(bad.refusedWith.code, 4001);
    const failures = (out.match(/auth failed/g) || []).length;
    await settle(2500); // the first retry would have come at 1 s
    assert.strictEqual((out.match(/auth failed/g) || []).length, failures, 'no retries after a refusal');

    console.log('[test] the token is in no log line and nowhere on the console');
    assert.ok(!out.includes(token), 'console');
    assert.ok(!fs.readFileSync(relayLog, 'utf8').includes(token), 'log file');
  } finally {
    for (const c of clients) c.close();
    proc.kill();
    await settle(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testLimits() {
  const token = 'limits-test-token';
  const log = [];
  const server = createRelayServer({
    port: LIMITS_PORT,
    host: '127.0.0.1',
    token,
    onLog: (m) => log.push(m),
    limits: { maxPerAddress: 6, rtPerSecond: 5, rtBurst: 5, preAuthBytes: 64 * 1024, batchBurst: 2, batchPerMinute: 1 },
  });
  const open = [];
  const raw = (p = '/') =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${LIMITS_PORT}${p}`);
      open.push(ws);
      ws.on('open', () => resolve({ ws, ok: true }));
      ws.on('unexpected-response', (req, res) => resolve({ ws, ok: false, status: res.statusCode }));
      ws.on('error', () => resolve({ ws, ok: false }));
    });
  try {
    await new Promise((r) => server.httpServer.once('listening', r));

    console.log('[test] limits: one address cannot hold more than its share of sockets');
    const got = [];
    for (let i = 0; i < 7; i++) got.push(await raw());
    assert.deepStrictEqual(got.map((g) => g.ok), [true, true, true, true, true, true, false]);
    assert.strictEqual(got[6].status, 503);
    for (const g of got) g.ws.terminate();
    await settle(200);

    console.log('[test] limits: what a socket may send before signing in is capped');
    // A junk frame is refused at once as a malformed auth (4002). What could
    // pile up is HELLO, which the handshake accepts any number of times while
    // it waits for the token — each one also queued by the relay until then.
    const flood = await raw(REALTIME_PATH);
    const closed = new Promise((r) => flood.ws.on('close', (code) => r(code)));
    const hello = JSON.stringify({ type: 'hello', protocolVersion: 1, pad: 'x'.repeat(40 * 1024) });
    flood.ws.send(hello);
    flood.ws.send(hello);
    assert.strictEqual(await closed, 1008);

    console.log('[test] limits: realtime frames over the rate are dropped, the socket stays up');
    const sender = new RelayClient({ url: `ws://127.0.0.1:${LIMITS_PORT}`, token, role: 'viewer', callsign: 'FAST' });
    const listener = new RelayClient({ url: `ws://127.0.0.1:${LIMITS_PORT}`, token, role: 'viewer', callsign: 'EAR' });
    const heard = [];
    listener.on('brief', (m) => m.type === 'brief-card-tick' && heard.push(m));
    sender.connect();
    listener.connect();
    await waitFor('both realtime sockets', () => sender.briefConnected && listener.briefConnected);
    await settle(200);
    for (let i = 0; i < 40; i++) sender.sendBrief({ type: 'brief-card-tick', hash: 'a'.repeat(64), index: i, done: true });
    await settle(500);
    assert.ok(heard.length >= 5 && heard.length <= 8, `about a burst's worth arrived (${heard.length})`);
    assert.ok(sender.briefConnected, 'and the sender is still connected');

    console.log('[test] limits: photo batches past the burst are dropped; the burst itself gets through');
    const photos = [];
    listener.on('reveal-batch', (b) => photos.push(b));
    await waitFor('bulk sockets', () => sender.connected && listener.connected);
    const one = [{ filename: '01.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('jpeg-bytes') }];
    sender.sendRevealBatch(one);
    sender.sendRevealBatch(one);
    sender.sendRevealBatch(one);
    await settle(600);
    assert.strictEqual(photos.length, 2, 'two quick presses both arrive, the third is over the burst');
    assert.ok(log.some((m) => m.includes('over 1 batches a minute')));
    sender.close();
    listener.close();
  } finally {
    for (const ws of open) ws.terminate();
    await new Promise((r) => server.close(r));
  }
}

(async () => {
  try {
    testConfig();
    await testEndToEnd();
    await testLimits();
    console.log('[dev-intel-relay-test] PASS');
    process.exit(0);
  } catch (err) {
    console.error(`[dev-intel-relay-test] FAIL: ${err.message}`);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    process.exit(1);
  }
})();
