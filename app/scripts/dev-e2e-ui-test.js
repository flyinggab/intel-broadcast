'use strict';

// End-to-end against the v0.4 viewer UI, driven through its real DOM.
//
// Covers what can be checked without eyes on a screen:
//   - photos reach the renderer as intel:// URLs, never base64 data URLs (§9.1)
//   - an idle arrival takes the BRIEF stage at 1/N and the banner says so
//   - HIDE CHROME leaves the photo and nothing else
//   - tabs switch pages, and SETUP does NOT
//   - rule C: an arrival during interaction queues with a QUEUED banner and
//     the page holds still — there is no badge any more
//   - RECEIVED curation: deselecting a tile shrinks the brief's queue without
//     moving the stage; HIDE/RESTORE empties and refills it
//   - share tiles drive what actually goes on the wire
//
// Usage: node scripts/dev-e2e-ui-test.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');
const { RelayClient } = require('../src/main/relayClient');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const CONFIG_PATH = path.join(APP_DIR, 'ui-e2e-config.local.json');
const EVAL_PATH = path.join(APP_DIR, 'ui-e2e-eval.js');

const RELAY_PORT = require('./dev-ports').uiE2E;
const TOKEN = 'ui-e2e-secret';

fs.rmSync(EVAL_PATH, { force: true });
fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify({
    relayHostEnabled: true,
    token: TOKEN,
    callsign: 'GHOSTRIDER 1-1',
    missionName: 'roman-sead-joker1',
    autoShow: true,
    gm: { relayPort: RELAY_PORT, funnelEnabled: false },
  }),
);

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
  detached: true,
  env: {
    ...process.env,
    INTEL_BROADCAST_LOCAL_CONFIG_PATH: CONFIG_PATH,
    INTEL_BROADCAST_VIEWER_PANEL_PROBE: '1',
    INTEL_BROADCAST_VIEWER_EVAL_PATH: EVAL_PATH,
    INTEL_BROADCAST_CHROME_IDLE_MS: '1500',
  },
});

let probe = null;
let output = '';
child.stdout.on('data', (d) => {
  const text = d.toString();
  output += text;
  process.stdout.write(`[app] ${text}`);
  for (const line of text.split('\n')) {
    const at = line.indexOf('PANEL_PROBE ');
    if (at === -1) continue;
    try {
      probe = JSON.parse(line.slice(at + 'PANEL_PROBE '.length));
    } catch {
      // chunk boundary; next tick covers it
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
    if (probe && predicate()) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${desc}\n  probe: ${JSON.stringify(probe)}`);
}

async function runInViewer(js) {
  // Wrapped in its own scope: every eval shares one global, so a repeated
  // `const` declaration would throw on the second call.
  fs.writeFileSync(EVAL_PATH, `(() => { ${js} })()`);
  const deadline = Date.now() + 10000;
  while (fs.existsSync(EVAL_PATH)) {
    if (Date.now() > deadline) throw new Error(`renderer never picked up: ${js.slice(0, 50)}`);
    await sleep(100);
  }
  await sleep(600);
}

/** Evaluates an object literal in the viewer and returns it. */
async function probeInViewer(objectLiteral) {
  const marker = `PROBE_${Date.now()}`;
  await runInViewer(`console.log('${marker} ' + JSON.stringify(${objectLiteral}))`);
  const m = new RegExp(`${marker} (\\{.*\\})`).exec(output);
  if (!m) throw new Error('viewer probe never reported');
  return JSON.parse(m[1]);
}

const click = (selector) => runInViewer(`document.querySelector(${JSON.stringify(selector)}).click()`);

// ONE press. The grid launcher is gone: the rail is always on screen, so
// getting anywhere costs a single press — which is why it replaced the menu.
async function goTo(dest) {
  if (probe.navCollapsed) await click('#menukey');
  // RECEIVED and SHARE are no longer destinations — they are views of INTEL,
  // picked from the strip. Still one press either way.
  // The views moved from the strip to the action bar: they are app verbs, not
  // navigation.
  if (dest === 'received' || dest === 'share') return click(`#abar .akey[data-view="${dest}"]`);
  await click(`.dest[data-dest="${dest}"]`);
}

function connectClient(callsign) {
  const client = new RelayClient({ url: `ws://localhost:${RELAY_PORT}`, token: TOKEN, role: 'viewer', callsign });
  clients.push(client);
  return new Promise((resolve) => {
    client.once('connected', () => resolve(client));
    client.connect();
  });
}

const photo = (name, fill) => ({ filename: name, mimeType: 'image/jpeg', buffer: Buffer.alloc(2048, fill) });

async function main() {
  await waitFor('the viewer to render', () => probe !== null);

  // --- the share gallery is populated from the bundled fixture folder -------
  await waitFor('the gallery to list the fixture folder', () => probe.tiles.length === 2);
  if (!probe.tiles.every((t) => t.selected)) throw new Error('photos should start selected');
  // §9.1: the renderer must hold URLs, never base64. The probe reports whether
  // each thumbnail src is an intel:// URL.
  if (!probe.tiles.every((t) => t.hasThumb)) {
    throw new Error(`thumbnails must be intel:// URLs, got ${JSON.stringify(probe.tiles)}`);
  }
  // The shipped markup boots empty: STANDBY until intel arrives.
  if (!probe.standby) throw new Error('an empty queue must show STANDBY');
  console.log('[e2e] gallery lists the folder, thumbnails served over intel://, stage is STANDBY');

  // --- arrival takes the BRIEF stage at 1/N AND says so ---------------------
  const alpha = await connectClient('JOKER 2-1');
  await sleep(400);
  alpha.sendRevealBatch([photo('a.jpg', 1), photo('b.jpg', 2), photo('c.jpg', 3)]);

  await waitFor('the arrival to take the stage', () => probe.stageSrc.startsWith('intel://blob/'));
  if (probe.page !== 'brief') throw new Error(`expected BRIEF to hold the photo, page=${probe.page}`);
  if (probe.standby) throw new Error('STANDBY must clear when intel lands');
  if (probe.pos !== '1 / 3') throw new Error(`arrival should land at 1 / 3, got "${probe.pos}"`);
  if (!probe.banner || !probe.banner.includes('JOKER 2-1')) {
    throw new Error(`a page that moves on its own must say why, got banner: ${probe.banner}`);
  }
  if (!/SWITCHED AUTOMATICALLY/.test(probe.bannerMeta || '')) {
    throw new Error(`switched banner must say so, got "${probe.bannerMeta}"`);
  }
  console.log('[e2e] arrival took the BRIEF stage at 1/3, banner announced the switch');

  // --- HIDE CHROME leaves the photo and nothing else ------------------------
  // Hotkey-only in the UI now; the intent channel stands in for the hotkey.
  // The chrome hides itself once you stop touching the app — no binding to
  // remember, and it is the state the kneeboard capture wants.
  // Arm the idle timer explicitly. Main only schedules the hide in response to
  // activity, and the first activity normally comes from the window gaining
  // focus — which a window spawned by a test script does not reliably get.
  // Relying on that made this assertion pass or fail by luck.
  await runInViewer(`window.dispatchEvent(new MouseEvent('mousemove'))`);
  // The chrome must NEVER disappear on its own. The rail and the key that
  // live in .strip, so hiding it strands the pilot on whatever page they are
  // on. This asserts it while the window is UNFOCUSED — document.hasFocus() is
  // false here, which is exactly the case that defeated an earlier fix that
  // kept the chrome only while focused.
  await sleep(4000);
  const chrome = await probeInViewer(`{
    hasFocus: document.hasFocus(),
    strip: !!document.querySelector('.strip').offsetParent,
    menukey: !!document.getElementById('menukey').offsetParent,
  }`);
  if (chrome.strip !== true || chrome.menukey !== true) {
    throw new Error(`navigation must stay reachable when idle, got ${JSON.stringify(chrome)}`);
  }
  if (probe.chromeHidden) throw new Error('chrome must not hide itself');
  console.log(`[e2e] idle with hasFocus=${chrome.hasFocus}: strip and nav key still there`);

  // --- tabs switch pages; SETUP does not ------------------------------------
  await goTo('received');
  await waitFor('RECEIVED page', () => probe.page === 'received');
  if (probe.batches.length !== 1) throw new Error(`expected 1 batch, got ${probe.batches.length}`);
  if (!probe.batches[0].who.includes('JOKER 2-1')) throw new Error(`batch shows "${probe.batches[0].who}"`);
  if (!/3 OF 3 IN BRIEF · \d{4}Z/.test(probe.batches[0].meta)) {
    throw new Error(`batch meta: "${probe.batches[0].meta}"`);
  }
  if (probe.batches[0].tiles.length !== 3) throw new Error('every received photo gets a tile');
  console.log('[e2e] RECEIVED lists the batch with callsign, selection count and Zulu time');

  // --- the rail is the navigation now -------------------------------------
  if (probe.navCollapsed) await click('#menukey');
  if (!probe.navDests.includes('brief') || !probe.navDests.includes('setup')) {
    throw new Error(`the rail must list every destination, got ${JSON.stringify(probe.navDests)}`);
  }
  if (probe.navLabels.some((l) => !l)) {
    throw new Error(`every rail key carries a caption, got ${JSON.stringify(probe.navLabels)}`);
  }
  console.log(`[e2e] rail lists ${probe.navDests.length} destinations, each captioned`);

  // ONE press to switch. That is the entire reason the rail replaced the grid
  // launcher, so it is asserted rather than assumed: no opening step first.
  await click('.dest[data-dest="setup"]');
  await waitFor('SETUP in one press', () => probe.page === 'setup');
  await click('.dest[data-dest="brief"]');
  await waitFor('BRIEF in one press', () => probe.page === 'brief');
  console.log('[e2e] one press per destination — no menu to open first');

  // Collapsing must never strand a pilot. The key that brings the rail back
  // lives in the STRIP rather than in the rail, so it survives its own
  // collapse — a control that disappears with the thing it toggles cannot
  // undo itself, and on BRIEF that would leave no navigation at all.
  await click('#menukey');
  await waitFor('the rail to collapse', () => probe.navCollapsed === true);
  await runInViewer(`
    const k = document.getElementById('menukey');
    const r = k.getBoundingClientRect();
    let hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    while (hit && !hit.id && hit.parentElement) hit = hit.parentElement;
    console.log('MENUKEY ' + JSON.stringify({ id: hit && hit.id, w: Math.round(r.width) }));
  `);
  const keyLine = output.split('\n').reverse().find((l) => l.includes('MENUKEY '));
  const key = JSON.parse(keyLine.slice(keyLine.indexOf('MENUKEY ') + 8));
  if (key.id !== 'menukey' || !key.w) {
    throw new Error(
      `with the rail collapsed the key that reopens it is unreachable (hit "${key.id}") — ` +
        'collapsing would trap the pilot with no way to navigate',
    );
  }
  await click('#menukey');
  await waitFor('the rail to come back', () => probe.navCollapsed === false);
  console.log('[e2e] the rail collapses and comes back from the strip');


  // SETUP is a page of this window now — the EFB carries its own settings.
  await goTo('setup');
  await waitFor('SETUP page', () => probe.page === 'setup');
  if (probe.setup !== 'net') throw new Error(`SETUP should open on NETWORK, got ${probe.setup}`);
  if (!probe.squadCodePrefix) throw new Error('SETUP should be rendering from the same snapshot');
  console.log('[e2e] SETUP is a page of the viewer, rendered from the same snapshot');

  // --- rule C: an arrival during interaction queues, page holds still ------
  const bravo = await connectClient('UZI 1-1');
  await sleep(300);
  await goTo('share'); // deliberate interaction, starts the grace window
  await waitFor('SHARE page', () => probe.page === 'share');
  bravo.sendRevealBatch([photo('d.jpg', 4)]);
  await waitFor('the arrival to join the queue', () => probe.batches.length === 2, 10000);
  if (probe.page !== 'share') throw new Error('a recent interaction must stop the page moving');
  if (!probe.banner || !probe.banner.includes('UZI 1-1')) {
    throw new Error(`with no badge the banner is the only trace — got ${probe.banner}`);
  }
  if (!/QUEUED/.test(probe.bannerMeta || '')) {
    throw new Error(`a held page must announce QUEUED, got "${probe.bannerMeta}"`);
  }
  console.log('[e2e] rule C: arrival during interaction queued with a QUEUED banner, page held still');

  // --- RECEIVED curation drives the brief's queue ---------------------------
  await goTo('brief');
  await waitFor('back on the brief', () => probe.page === 'brief');
  if (probe.pos !== '2 / 4') {
    // 1 (d.jpg, prepended) + 3 (a/b/c) — the stage stayed on a.jpg, renumbered.
    throw new Error(`prepend should renumber the held stage to 2 / 4, got "${probe.pos}"`);
  }
  await goTo('received');
  await waitFor('RECEIVED again', () => probe.page === 'received');

  // Deselect the photo BEHIND the stage (b.jpg): queue shrinks, stage holds.
  await click('.tile[data-filename="b.jpg"]');
  await waitFor('the tile to toggle off', () =>
    probe.batches.some((b) => b.tiles.some((t) => t.filename === 'b.jpg' && !t.selected)));
  if (probe.stageFile !== 'A.JPG') throw new Error(`deselecting b.jpg must not move the stage off ${probe.stageFile}`);
  if (probe.pos !== '2 / 3') throw new Error(`queue must shrink to 3, got "${probe.pos}"`);

  // HIDE the whole JOKER batch (the older one, last in the newest-first
  // list): only d.jpg remains; the stage falls to it.
  await click('.batch[data-batch-id]:last-child .batch__all');
  await waitFor('the batch to hide', () => probe.batches.some((b) => b.all === 'RESTORE'), 10000);
  if (probe.stageFile !== 'D.JPG') throw new Error(`stage must fall to the surviving photo, got ${probe.stageFile}`);
  if (probe.pos !== '1 / 1') throw new Error(`queue must be d.jpg alone, got "${probe.pos}"`);

  // RESTORE brings the batch back.
  await click('.batch__all[data-on="1"]');
  await waitFor('the batch to restore', () => probe.batches.every((b) => b.all === 'HIDE'), 10000);
  if (probe.pos !== '1 / 4') throw new Error(`restore must refill the queue, got "${probe.pos}"`);
  console.log('[e2e] RECEIVED curation: tile off, batch HIDE, RESTORE — queue follows, stage repairs');

  // --- share selection decides what goes on the wire ------------------------
  await goTo('share');
  await waitFor('share page', () => probe.page === 'share');
  // One key now: with photos selected it reads DESELECT ALL and clears them.
  await click('#share-toggle');
  await waitFor('nothing selected', () => probe.tiles.every((t) => !t.selected));
  if (!/SELECT ALL/.test(probe.shareToggle || '')) {
    throw new Error(`with nothing selected the key must offer SELECT ALL, got "${probe.shareToggle}"`);
  }
  if (!/NOTHING SELECTED/.test(probe.revealBtn)) throw new Error(`button label: "${probe.revealBtn}"`);
  await click('#share-grid .tile[data-filename]:last-child');
  await waitFor('one selected', () => probe.tiles.filter((t) => t.selected).length === 1);
  const picked = probe.tiles.find((t) => t.selected).filename;

  const received = new Promise((resolve) => alpha.once('reveal-batch', resolve));
  await click('#share-reveal');
  const batch = await received;
  const names = batch.items.map((i) => i.filename);
  if (names.length !== 1) throw new Error(`expected only the selected photo, got ${JSON.stringify(names)}`);
  if (batch.sharedBy !== 'GHOSTRIDER 1-1') throw new Error(`attribution: "${batch.sharedBy}"`);
  // imagePrep runs on the sender: the shipped bytes should be smaller than the
  // ~300-460KB originals in the fixture folder.
  const bytes = batch.items[0].buffer.length;
  if (bytes >= 300 * 1024) throw new Error(`sender-side compression did not run: ${bytes} bytes`);
  console.log(`[e2e] shared only "${picked}", compressed to ${(bytes / 1024).toFixed(0)}KB on the way out`);

  console.log('[dev-e2e-ui-test] PASS');
  cleanup(0);
}

main().catch((err) => {
  console.error(`[e2e] FAIL: ${err.message}`);
  cleanup(1);
});

setTimeout(() => {
  console.error('[e2e] FAIL: overall timeout');
  cleanup(1);
}, 150000);
