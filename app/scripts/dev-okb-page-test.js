'use strict';

// The dashboard page, loaded the way OpenKneeboard loads it: over http, with
// no Electron preload, with `window.OpenKneeboard` present.
//
// This is the test that would have caught the bug it was written after. A tab
// rendered the shipped empty markup and sat on STANDBY for ever, because
// WebView2 has no preload and therefore no `window.viewerAPI` — and nothing in
// the suite ever loaded the page the way OpenKneeboard does. dev-okb-test
// covers the server's side of the transport; this covers the page's.
//
// It also answers the question a pilot actually asks: if Tac Link restarts
// mid-flight, do I have to touch the tab? Asserted by taking the server away
// and bringing it back while the page stays open.
//
// Usage: node scripts/dev-okb-page-test.js

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { createOkbServer } = require('../src/main/okbServer');
const { killApp } = require('./dev-electron');

const APP_DIR = path.join(__dirname, '..');
const HARNESS = path.join(__dirname, 'fixtures', 'okb-page-harness.js');
const PORT = require('./dev-ports').okbPage;

const HASH = 'a'.repeat(64);
const PHOTO = Buffer.from('pretend jpeg bytes');
const blobs = { get: (h) => (h === HASH ? { buffer: PHOTO, mimeType: 'image/jpeg' } : null) };

// A snapshot with one photo on the stage. The URL is already rewritten, the
// way main rewrites it for this transport.
const SNAPSHOT = {
  callsign: 'GHOSTRIDER 1-1',
  isHost: true,
  connected: true,
  peers: [],
  page: 'brief',
  navCollapsed: false,
  chromeHidden: false,
  focused: true,
  autoShow: true,
  locale: 'en',
  banner: null,
  brief: { presenting: false, presenter: null, focusHash: null, tool: 'pen', cursor: null, inkRevs: {}, live: false, locked: false, focusMissing: false },
  queue: {
    total: 1,
    pos: 0,
    current: { batchId: 1, filename: 'TGT.JPG', url: `/blob/${HASH}`, sharedBy: 'JOKER 2-1', receivedAt: Date.now(), hash: HASH },
  },
  batches: [],
  photos: [],
  selectedCount: 0,
  photoCount: 0,
  counters: { sent: 0, received: 1, drops: 0 },
};

let server = null;
const startServer = () =>
  createOkbServer({ port: PORT, onLog: () => {}, blobs, getSnapshot: () => SNAPSHOT, onIntent: () => {} });

server = startServer();

const child = spawn(path.join(APP_DIR, 'node_modules', '.bin', 'electron'), [HARNESS, '--port', String(PORT), '--no-sandbox'], {
  cwd: APP_DIR,
  detached: true,
  env: process.env,
});

let output = '';
child.stdout.on('data', (d) => {
  output += d.toString();
  // The harness tells us when to take the server away and bring it back, so
  // the two sides stay in step without sleeping in lockstep here.
  if (/OKBPAGE_MARK server-down/.test(output) && server) {
    server.close();
    server = null;
  } else if (/OKBPAGE_MARK server-up/.test(output) && !server) {
    server = startServer();
  }
});
child.stderr.on('data', () => {});

function finish(code) {
  killApp(child);
  if (server) server.close();
  setTimeout(() => process.exit(code), 200);
}

function read(label) {
  const m = new RegExp(`${label} (\\{.*\\})`).exec(output);
  if (!m) throw new Error(`the harness never reported ${label}\n${output.slice(-600)}`);
  return JSON.parse(m[1]);
}

child.on('exit', () => {
  try {
    if (/OKBPAGE_ERROR/.test(output)) throw new Error(/OKBPAGE_ERROR (.*)/.exec(output)[1]);

    const connected = read('OKBPAGE_CONNECTED');
    assert.strictEqual(connected.surface, 'okb', 'the page must know it is on the OpenKneeboard surface');
    assert.strictEqual(connected.okbActive, true);
    assert.strictEqual(connected.hasApi, true, 'the bridge must install a window.viewerAPI — there is no preload here');
    assert.strictEqual(connected.socket, 'open', 'and it must actually reach the app');

    // THE POINT. Without the transport this is exactly what a pilot saw.
    assert.strictEqual(
      connected.standby,
      false,
      'the tab is on STANDBY with a photo in the queue — state is not reaching the page',
    );
    assert.ok(
      connected.stageSrc.startsWith(`/blob/${HASH}`),
      `the stage must load the photo over /blob, got "${connected.stageSrc}"`,
    );
    console.log('[okb-page] loaded over http with no preload: socket open, state applied, photo on the stage');

    // Tac Link restarting under an open tab.
    const dropped = read('OKBPAGE_DROPPED');
    assert.strictEqual(dropped.socket, 'closed', 'losing the app must be noticed, not ignored');

    const back = read('OKBPAGE_RECONNECTED');
    assert.strictEqual(
      back.socket,
      'open',
      'the tab must reconnect on its own when the app comes back — a pilot cannot re-add a tab mid-flight',
    );
    assert.strictEqual(back.standby, false, 'and must be re-sent the current state, not left blank');
    console.log('[okb-page] the app can restart under an open tab: it reconnects and is re-sent state');

    console.log('[dev-okb-page-test] PASS');
    finish(0);
  } catch (err) {
    console.error(`[dev-okb-page-test] FAIL: ${err.message}`);
    finish(1);
  }
});

setTimeout(() => {
  console.error('[dev-okb-page-test] FAIL: timeout');
  finish(1);
}, 90000);
