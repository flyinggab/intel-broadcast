'use strict';

// Side-panel e2e against the real viewer window, driven through its actual
// DOM: INTEL_BROADCAST_VIEWER_PANEL_PROBE dumps the rendered panel every tick
// and doubles as a "run this in the renderer" channel
// (INTEL_BROADCAST_VIEWER_EVAL_PATH) so clicks go through real event handlers.
//
//   Received tab — two clients share; the host's panel lists both newest
//     first with callsign + count + time, unread bubbles show a count, and
//     clicking the older row re-displays that batch while clearing only its
//     own bubble.
//   Share tab — the gallery lists the bundled fixture folder with thumbnails
//     (all selected by default), "None" + picking one leaves exactly one, and
//     the Share button sends ONLY that photo — asserted on a real relay
//     client receiving the fan-out.
//
// The initial unread state is deliberately never asserted: it depends on
// whether the window happens to hold OS focus. Everything checked here is
// driven by explicit clicks.
//
// Usage: node scripts/dev-e2e-panel-test.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');
const { RelayClient } = require('../src/main/relayClient');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const CONFIG_PATH = path.join(APP_DIR, 'panel-e2e-config.local.json');
const EVAL_PATH = path.join(APP_DIR, 'panel-e2e-eval.js');

const RELAY_PORT = require('./dev-ports').panel;
const TOKEN = 'panel-e2e-secret';
const MISSION = 'roman-sead-joker1'; // bundled 2-photo fixture folder

fs.rmSync(EVAL_PATH, { force: true });
fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify({
    relayHostEnabled: true,
    token: TOKEN,
    callsign: 'host-self',
    missionName: MISSION,
    gm: { relayPort: RELAY_PORT, funnelEnabled: false },
  }),
);

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
    detached: true, // process GROUP, so killTree reaches the real binary
  env: {
    ...process.env,
    INTEL_BROADCAST_LOCAL_CONFIG_PATH: CONFIG_PATH,
    INTEL_BROADCAST_VIEWER_PANEL_PROBE: '1',
    INTEL_BROADCAST_VIEWER_EVAL_PATH: EVAL_PATH,
  },
});

let lastProbe = null;
let output = '';
child.stdout.on('data', (d) => {
  const text = d.toString();
  output += text;
  process.stdout.write(`[app] ${text}`);
  for (const line of text.split('\n')) {
    const at = line.indexOf('PANEL_PROBE ');
    if (at === -1) continue;
    try {
      lastProbe = JSON.parse(line.slice(at + 'PANEL_PROBE '.length));
    } catch {
      // partial line split across chunks — the next probe tick covers it
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

const clients = [];
function cleanup(code) {
  fs.rmSync(CONFIG_PATH, { force: true });
  fs.rmSync(EVAL_PATH, { force: true });
  for (const c of clients) c.close();
  killApp(child);
  setTimeout(() => process.exit(code), 300);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lastProbe && predicate()) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${desc}\n  last probe: ${JSON.stringify(lastProbe)}`);
}

/** Queues JS to run in the viewer renderer; resolves once it's been picked up. */
async function runInViewer(js) {
  fs.writeFileSync(EVAL_PATH, js);
  const deadline = Date.now() + 10000;
  while (fs.existsSync(EVAL_PATH)) {
    if (Date.now() > deadline) throw new Error(`renderer never picked up: ${js.slice(0, 60)}`);
    await sleep(100);
  }
  await sleep(500); // let the resulting re-render land in a probe tick
}

function connectClient(callsign) {
  const client = new RelayClient({ url: `ws://localhost:${RELAY_PORT}`, token: TOKEN, role: 'viewer', callsign });
  clients.push(client);
  return new Promise((resolve) => {
    client.once('connected', () => resolve(client));
    client.connect();
  });
}

const photo = (name, fill) => ({ filename: name, mimeType: 'image/jpeg', buffer: Buffer.alloc(64, fill) });

async function main() {
  await waitFor('the viewer panel to render', () => lastProbe !== null);

  // --- Received tab -------------------------------------------------------
  const alpha = await connectClient('Ghostrider-1');
  const bravo = await connectClient('Viper-2');
  await sleep(300);

  alpha.sendRevealBatch([photo('a.jpg', 1), photo('b.jpg', 2)]);
  await waitFor('the first share to appear as a row', () => lastProbe.rows.length === 1);
  await sleep(400); // keep the two arrivals distinguishable in order
  bravo.sendRevealBatch([photo('c.jpg', 3)]);
  await waitFor('the second share to appear', () => lastProbe.rows.length === 2);

  const [newest, oldest] = lastProbe.rows;
  if (newest.who !== 'Viper-2') throw new Error(`newest row should be Viper-2, got "${newest.who}"`);
  if (oldest.who !== 'Ghostrider-1') throw new Error(`oldest row should be Ghostrider-1, got "${oldest.who}"`);
  if (!newest.current) throw new Error('the newest arrival should be the displayed one');
  if (!/^1 photo · \d{2}:\d{2}$/.test(newest.meta)) throw new Error(`bad meta line: "${newest.meta}"`);
  if (!/^2 photos · \d{2}:\d{2}$/.test(oldest.meta)) throw new Error(`bad meta line: "${oldest.meta}"`);
  if (!lastProbe.indicator.includes('from Viper-2')) {
    throw new Error(`indicator should credit Viper-2: "${lastProbe.indicator}"`);
  }
  console.log('[e2e] received rows render newest-first with callsign, photo count and time');

  // Force both unread so bubble assertions don't depend on OS focus.
  await runInViewer(`intelHistory.entries.forEach((e) => { e.unread = true; }); renderIntelList();`);
  await waitFor('both rows unread with a badge of 2', () => lastProbe.rows.every((r) => r.unread) && lastProbe.badge === 2);
  console.log('[e2e] unread bubbles show, badge counts 2');

  await runInViewer(`document.querySelectorAll('.intel-row')[1].click()`);
  await waitFor('the older row to become current', () => lastProbe.rows[1].current);
  if (lastProbe.rows[1].unread) throw new Error('clicking a row must clear its unread bubble');
  if (!lastProbe.rows[0].unread) throw new Error('the other row should still be unread');
  if (lastProbe.badge !== 1) throw new Error(`badge should be 1, got ${lastProbe.badge}`);
  if (!lastProbe.indicator.includes('from Ghostrider-1')) {
    throw new Error(`clicking should switch the displayed batch: "${lastProbe.indicator}"`);
  }
  console.log('[e2e] clicking an older row re-displays it and clears only its own bubble');

  // --- Share tab ----------------------------------------------------------
  await runInViewer(`openPanel('share')`);
  await waitFor('the gallery to list the fixture folder', () => lastProbe.tiles.length === 2);
  if (!lastProbe.tiles.every((t) => t.selected)) throw new Error('every photo should start selected');
  if (!lastProbe.tiles.every((t) => t.hasThumb)) throw new Error('thumbnails should render for the fixture photos');
  if (!/Share 2 photos/.test(lastProbe.shareBtn)) throw new Error(`share button label: "${lastProbe.shareBtn}"`);
  console.log('[e2e] gallery lists the folder with thumbnails, all selected by default');

  await runInViewer(`document.getElementById('select-none').click()`);
  await waitFor('nothing selected', () => lastProbe.tiles.every((t) => !t.selected));
  if (lastProbe.shareBtn.trim() !== 'Share') throw new Error(`button should reset: "${lastProbe.shareBtn}"`);

  await runInViewer(`document.querySelectorAll('.share-tile')[1].click()`);
  await waitFor('exactly one photo selected', () => lastProbe.tiles.filter((t) => t.selected).length === 1);
  const picked = lastProbe.tiles.find((t) => t.selected).filename;
  console.log(`[e2e] "None" then picking one leaves exactly "${picked}" selected`);

  const received = new Promise((resolve) => bravo.once('reveal-batch', resolve));
  await runInViewer(`document.getElementById('share-btn').click()`);
  const batch = await received;
  const names = batch.items.map((i) => i.filename);
  if (names.length !== 1 || names[0] !== picked) {
    throw new Error(`expected only "${picked}", got ${JSON.stringify(names)}`);
  }
  if (batch.sharedBy !== 'host-self') throw new Error(`wrong attribution: "${batch.sharedBy}"`);
  console.log('[e2e] Share sent ONLY the selected photo, attributed to the sharer');

  // "Select all" then the hotkey path must send the whole folder again —
  // proves the gallery selection and the hotkey are one setting.
  await runInViewer(`document.getElementById('select-all').click()`);
  await waitFor('everything selected again', () => lastProbe.tiles.every((t) => t.selected));
  const bothReceived = new Promise((resolve) => bravo.once('reveal-batch', resolve));
  await runInViewer(`document.getElementById('share-btn').click()`);
  const full = await bothReceived;
  if (full.items.length !== 2) throw new Error(`select-all should share both, got ${full.items.length}`);
  console.log('[e2e] "Select all" shares the whole folder again');

  // --- Settings from the panel --------------------------------------------
  await runInViewer(`document.getElementById('panel-settings').click()`);
  await waitFor('settings to open from the panel', () => /\[settingsWindow\] window/.test(output));
  console.log('[e2e] the panel opens Settings');

  console.log('[dev-e2e-panel-test] PASS');
  cleanup(0);
}

main().catch((err) => {
  console.error(`[e2e] FAIL: ${err.message}`);
  cleanup(1);
});

setTimeout(() => {
  console.error('[e2e] FAIL: overall timeout');
  cleanup(1);
}, 120000);
