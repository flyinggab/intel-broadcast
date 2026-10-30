#!/usr/bin/env node
'use strict';

// The dcs.log follower and the TACLINK line parser, against recorded-format
// samples (scripts/fixtures/dcslog/, written in the line format DCS 2.9
// produces). Plain node, no Electron, no DCS.
//
// The follower is driven by calling poll() by hand, so every case is exact:
// no timers, no sleeps.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DcsLogFollower } = require('../src/main/dcsLog');
const { parseLogLine, MissionIntel, checkWire, MAX_LINE_BYTES } = require('../src/main/intel');

const FIXTURES = path.join(__dirname, 'fixtures', 'dcslog');
const sample = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'taclink-dcslog-'));
}

function follow(file, opts = {}) {
  const f = new DcsLogFollower({ file, ...opts });
  const seen = { lines: [], rotated: 0, status: [] };
  f.on('line', (l) => seen.lines.push(l));
  f.on('rotated', () => (seen.rotated += 1));
  f.on('status', (s) => seen.status.push(s));
  return { f, seen };
}

const HEADER = (t) => `=== Log opened UTC 2026-10-30 ${t}\n`;
const line = (t, msg) => `2026-10-30 ${t}.000 INFO    SCRIPTING (Main): ${msg}\n`;
// What the follower hands over: one line, no line ending.
const one = (t, msg) => line(t, msg).trimEnd();

function testParser() {
  console.log('[test] the parser reads a normal run: three messages out, the rest skipped for a reason');
  const intel = new MissionIntel();
  const out = { sent: [], dup: 0, load: 0, errors: [], ignored: [] };
  for (const l of sample('normal.log').split('\n')) {
    const r = parseLogLine(l);
    if (!r) continue;
    if (r.load) {
      out.load += 1;
      intel.reset();
    } else if (r.message) {
      if (intel.accept(r.message)) out.sent.push(r.message);
      else out.dup += 1;
    } else if (r.error) out.errors.push(r.error);
    else out.ignored.push(r.ignored);
  }
  assert.strictEqual(out.load, 1, 'loadMission is seen once, loadMission Done is not a second load');
  assert.deepStrictEqual(
    out.sent.map((m) => `${m.type} ${m.id}`),
    ['intel-nineline abu-musa-cas-test-0007', 'intel-call abu-musa-cas-test-0009', 'intel-call abu-musa-cas-test-0010'],
  );
  assert.strictEqual(out.dup, 1, 'the same id written twice goes out once');
  assert.deepStrictEqual(out.errors, ['broken JSON', 'lines must be nine strings']);
  assert.deepStrictEqual(out.ignored, ['version 2', 'kind "retask"']);

  const nl = out.sent[0];
  assert.strictEqual(nl.lines.length, 9);
  assert.strictEqual(nl.lines[6], 'laser, 1536');
  assert.strictEqual(nl.from, 'Pointer');
  assert.strictEqual(nl.to, 'Joker');
  assert.strictEqual(nl.time, '07:41:12');
  assert.strictEqual(nl.logTime, '2026-10-30T07:41:12.880Z', 'when DCS wrote it, UTC');
  assert.deepStrictEqual(nl.target, { lat: 25.879983, lon: 55.043267, elev_ft: 10 });
  assert.strictEqual(nl.laser, 1536);
  assert.ok(nl.remarks.startsWith('Laser-target line 086.'));
  assert.strictEqual(out.sent[2].text, 'Good hits. Target destroyed, one secondary.', 'env.warning lines count too');

  console.log('[test] an ERROR line quoting the prefix is not a message');
  const quoted = sample('normal.log').split('\n').find((l) => l.includes('ERROR'));
  assert.strictEqual(parseLogLine(quoted), null);

  console.log('[test] limits: oversize line, long fields, control characters, unknown fields');
  const big = 'x'.repeat(MAX_LINE_BYTES);
  const over = parseLogLine(one('07:50:00', `TACLINK: {"v":1,"kind":"call","id":"a","mission":"m","text":"${big}"}`));
  assert.ok(over.error && over.error.startsWith('line over'), 'a line past the cap is refused before parsing');
  const long = parseLogLine(
    one('07:50:01', `TACLINK: {"v":1,"kind":"call","id":"a","mission":"m","text":"${'y'.repeat(201)}"}`),
  );
  assert.strictEqual(long.error, 'bad text', 'call text is capped at 200');
  const ctl = parseLogLine(
    one('07:50:02', 'TACLINK: {"v":1,"kind":"call","id":"a","mission":"m","text":"one\\u0007two\\tthree","extra":{"x":1}}'),
  );
  assert.strictEqual(ctl.message.text, 'onetwo three');
  assert.ok(!('extra' in ctl.message), 'unknown fields are not carried');
  const noId = parseLogLine(one('07:50:03', 'TACLINK: {"v":1,"kind":"call","mission":"m","text":"t"}'));
  assert.strictEqual(noId.error, 'bad id');
  const crlf = parseLogLine(one('07:50:04', 'TACLINK: {"v":1,"kind":"call","id":"b","mission":"m","text":"t"}') + '\r');
  assert.ok(crlf === null || crlf.error, 'a stray CR is the follower\'s job to strip, not a valid message');

  console.log('[test] the same id in a new mission load goes out again');
  const intel2 = new MissionIntel();
  const call = { type: 'intel-call', id: 'x-1', mission: 'm' };
  assert.ok(intel2.accept(call));
  assert.ok(!intel2.accept(call));
  intel2.reset();
  assert.ok(intel2.accept(call), 'a reloaded mission numbers from 1 again');

  console.log('[test] history keeps the last 50, oldest first');
  const intel3 = new MissionIntel();
  for (let i = 0; i < 60; i++) intel3.accept({ type: 'intel-call', id: `c${i}`, mission: 'm' });
  const h = intel3.history();
  assert.strictEqual(h.length, 50);
  assert.strictEqual(h[0].id, 'c10');
  assert.strictEqual(h[49].id, 'c59');

  console.log('[test] the wire check accepts what the relay sends and nothing looser');
  assert.ok(checkWire({ ...out.sent[0] }));
  assert.strictEqual(checkWire({ ...out.sent[0], lines: out.sent[0].lines.slice(0, 8) }), null);
  assert.strictEqual(checkWire({ type: 'intel-call', id: 'a', mission: 'm', text: '' }), null);
}

function testFollower() {
  const dir = tmpdir();
  const file = path.join(dir, 'dcs.log');

  console.log('[test] started on a running log: old lines are not replayed, new ones are read');
  fs.writeFileSync(file, HEADER('07:30:02') + line('07:30:05', 'OLD: before the relay'));
  const { f, seen } = follow(file);
  f.poll();
  assert.deepStrictEqual(seen.lines, []);
  fs.appendFileSync(file, line('07:31:00', 'NEW: one'));
  f.poll();
  assert.deepStrictEqual(seen.lines.map((l) => l.slice(-8)), ['NEW: one']);

  console.log('[test] a line written in two halves is read once, whole');
  const whole = line('07:31:01', 'NEW: written in two writes');
  fs.appendFileSync(file, whole.slice(0, 30));
  f.poll();
  assert.strictEqual(seen.lines.length, 1, 'half a line is held back');
  fs.appendFileSync(file, whole.slice(30));
  f.poll();
  assert.strictEqual(seen.lines[1], whole.trimEnd());

  console.log('[test] CRLF endings are stripped');
  fs.appendFileSync(file, line('07:31:02', 'NEW: crlf').replace('\n', '\r\n'));
  f.poll();
  assert.ok(seen.lines[2].endsWith('NEW: crlf'));

  console.log('[test] the file is not held open between polls: DCS can rename it');
  // On Windows a rename of a file someone holds open without share-delete
  // fails; this is the check that the follower is not that someone.
  fs.renameSync(file, path.join(dir, 'dcs.log.old'));

  console.log('[test] DCS restarting: the log missing, then a new one read from the top');
  f.poll();
  assert.strictEqual(f.status, 'missing');
  fs.writeFileSync(file, HEADER('08:10:00') + line('08:10:05', 'NEW: second run'));
  f.poll();
  assert.strictEqual(seen.rotated, 1);
  assert.ok(seen.lines[seen.lines.length - 1].endsWith('NEW: second run'));

  console.log('[test] a new log that replaced the old between two polls is spotted by its header');
  const before = seen.lines.length;
  const bigger = HEADER('08:20:00') + line('08:20:01', 'NEW: third run, first') + 'x'.repeat(400) + '\n' + line('08:20:02', 'NEW: third run, second');
  fs.writeFileSync(file, bigger);
  f.poll();
  assert.strictEqual(seen.rotated, 2);
  assert.ok(seen.lines.slice(before).some((l) => l.endsWith('NEW: third run, second')));

  console.log('[test] a log that got shorter under the same header is a new log too');
  fs.writeFileSync(file, HEADER('08:20:00'));
  f.poll();
  assert.strictEqual(seen.rotated, 3);

  console.log('[test] a runaway line is dropped up to its newline, and reading goes on');
  const small = follow(file, { maxLineBytes: 1024 });
  small.f.poll();
  fs.appendFileSync(file, 'z'.repeat(5000));
  small.f.poll();
  fs.appendFileSync(file, 'z'.repeat(5000) + '\n' + line('08:30:00', 'NEW: after the runaway'));
  small.f.poll();
  assert.deepStrictEqual(small.seen.lines.map((l) => l.slice(-22)), ['NEW: after the runaway']);

  console.log('[test] started mid-line: the rest of that line is skipped, not read as a line');
  const mid = path.join(dir, 'mid.log');
  fs.writeFileSync(mid, HEADER('09:00:00') + '2026-10-30 09:00:01.000 INFO    SCRIPTING (Main): HALF');
  const m = follow(mid);
  m.f.poll();
  fs.appendFileSync(mid, ' A LINE\n' + line('09:00:02', 'NEW: next'));
  m.f.poll();
  assert.deepStrictEqual(m.seen.lines.map((l) => l.slice(-9)), ['NEW: next']);

  console.log('[test] no log at start: the one that appears is read from its first line');
  const late = path.join(dir, 'late.log');
  const l = follow(late);
  l.f.poll();
  assert.strictEqual(l.f.status, 'missing');
  fs.writeFileSync(late, HEADER('10:00:00') + line('10:00:01', 'NEW: first line of a new log'));
  l.f.poll();
  assert.strictEqual(l.seen.lines.length, 2, 'the header and the line');
  assert.strictEqual(l.seen.rotated, 0, 'nothing was being followed, so nothing rotated');

  console.log('[test] the recorded run read through the follower gives the same three messages');
  const rec = path.join(dir, 'recorded.log');
  const r = follow(rec);
  r.f.poll(); // missing: everything that follows is new
  fs.writeFileSync(rec, sample('normal.log'));
  r.f.poll();
  const intel = new MissionIntel();
  const sent = [];
  for (const x of r.seen.lines) {
    const p = parseLogLine(x);
    if (p && p.load) intel.reset();
    else if (p && p.message && intel.accept(p.message)) sent.push(p.message.id);
  }
  assert.deepStrictEqual(sent, ['abu-musa-cas-test-0007', 'abu-musa-cas-test-0009', 'abu-musa-cas-test-0010']);

  fs.rmSync(dir, { recursive: true, force: true });
}

try {
  testParser();
  testFollower();
  console.log('[dev-dcslog-test] PASS');
} catch (err) {
  console.error(`[dev-dcslog-test] FAIL: ${err.message}`);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
}
