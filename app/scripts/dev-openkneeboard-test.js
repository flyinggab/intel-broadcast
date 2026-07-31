'use strict';

// Unit test for openKneeboard.js — the relay that lets ONE key turn both this
// app's page and OpenKneeboard's.
//
// Windows hands a global hotkey to exactly one process (RegisterHotKey fails
// outright if another app owns the combination), so the two apps cannot each
// bind the same key. This app owns it and forwards the intent through
// OpenKneeboard's documented remote-control executables. This test drives that
// against a stub utilities folder, so it runs anywhere.
//
// Usage: node scripts/dev-openkneeboard-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'okb-utils-'));
const FIRED = path.join(DIR, 'fired.txt');

// Stand-ins for the real executables. On Windows the app spawns .exe files
// directly; here a shell script is enough to prove the right one is chosen
// and that dispatch is fire-and-forget.
function stub(name, label) {
  const p = path.join(DIR, name);
  fs.writeFileSync(p, `#!/bin/sh\necho ${label} >> ${JSON.stringify(FIRED)}\n`);
  fs.chmodSync(p, 0o755);
}

process.env.INTEL_BROADCAST_OKB_UTILITIES = DIR;
const okb = require('../src/main/openKneeboard');

function fired() {
  try {
    return fs.readFileSync(FIRED, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // --- nothing installed: detection is false, sending is a silent no-op ----
  assert.strictEqual(okb.findUtilitiesDir(), null, 'an empty folder is not an install');
  assert.strictEqual(okb.isAvailable(), false);
  assert.strictEqual(okb.sendPage('next'), false, 'no install means nothing dispatched');
  console.log('[test] absent OpenKneeboard: detected as absent, send is a no-op');

  // --- installed -----------------------------------------------------------
  stub(okb.COMMANDS.next, 'NEXT');
  stub(okb.COMMANDS.prev, 'PREV');
  assert.strictEqual(okb.findUtilitiesDir(), DIR);
  assert.strictEqual(okb.isAvailable(), true, 'presence is keyed on the NEXT_PAGE executable');
  console.log('[test] detection keys on the real executable name');

  // --- the right command for each direction --------------------------------
  assert.strictEqual(okb.sendPage('next'), true);
  await sleep(400);
  assert.deepStrictEqual(fired(), ['NEXT'], 'next must run NEXT_PAGE');

  assert.strictEqual(okb.sendPage('prev'), true);
  await sleep(400);
  assert.deepStrictEqual(fired(), ['NEXT', 'PREV'], 'prev must run PREVIOUS_PAGE');
  console.log('[test] next/prev map to NEXT_PAGE/PREVIOUS_PAGE');

  // --- an unknown direction dispatches nothing -----------------------------
  assert.strictEqual(okb.sendPage('sideways'), false);
  assert.strictEqual(okb.sendPage(undefined), false);
  await sleep(200);
  assert.strictEqual(fired().length, 2, 'no stray dispatch');
  console.log('[test] unknown directions dispatch nothing');

  // --- dispatch is fire-and-forget -----------------------------------------
  // A page turn runs on the hotkey path; it must return immediately rather
  // than waiting on a process, and a failing executable must not throw.
  const started = Date.now();
  okb.sendPage('next');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 150, `dispatch should not block the hotkey, took ${elapsed}ms`);

  fs.writeFileSync(path.join(DIR, okb.COMMANDS.next), 'not executable at all');
  fs.chmodSync(path.join(DIR, okb.COMMANDS.next), 0o644);
  const logs = [];
  assert.doesNotThrow(() => okb.sendPage('next', { onLog: (m) => logs.push(m) }));
  await sleep(400);
  console.log('[test] dispatch never blocks and never throws');

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log('[dev-openkneeboard-test] PASS');
}

main().catch((err) => {
  fs.rmSync(DIR, { recursive: true, force: true });
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
